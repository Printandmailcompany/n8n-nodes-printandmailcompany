'use strict';

/**
 * Runs the built nodes (dist/) the way n8n runs them, without n8n: the parameters of a node with their defaults
 * (NodeHelpers.getNodeParameters, as n8n's Workflow does), requests with the credential's authentication applied, binary
 * input items, static data for the trigger, and continue on fail. Requests go to a real HTTP server: the fake API of the
 * tests (test/fake-api.js) or a local copy of the app (test/e2e-local.js).
 */

const path = require('node:path');
const { NodeApiError, NodeHelpers, NodeOperationError } = require('n8n-workflow');

const DIST = path.join(__dirname, '..', 'dist');
const { PrintAndMailCompany } = require(
	path.join(DIST, 'nodes/PrintAndMailCompany/PrintAndMailCompany.node.js'),
);
const { PrintAndMailCompanyTrigger } = require(
	path.join(DIST, 'nodes/PrintAndMailCompany/PrintAndMailCompanyTrigger.node.js'),
);
const { PrintAndMailCompanyApi } = require(
	path.join(DIST, 'credentials/PrintAndMailCompanyApi.credentials.js'),
);

const credentialType = new PrintAndMailCompanyApi();

/** The credential as n8n stores it: the hidden Base URL keeps its default unless set */
const credentialsWith = (data) => {
	const defaults = Object.fromEntries(credentialType.properties.map((p) => [p.name, p.default]));
	return { ...defaults, ...data };
};

/** `={{$credentials.apiKey}}`-style values of the credential's authenticate and test request */
const resolveCredentialValue = (value, credentials) =>
	typeof value === 'string' && value.startsWith('=')
		? value
				.slice(1)
				.replace(/\{\{\s*\$credentials\.(\w+)\s*\}\}/g, (_, key) => String(credentials[key] ?? ''))
		: value;

const hasHeader = (headers, name) => Object.keys(headers).some((h) => h.toLowerCase() === name);

/**
 * this.helpers.httpRequest of n8n (backend-network): qs as the query string, JSON bodies for objects, Buffers as they
 * are, JSON answers parsed, an error for HTTP errors unless ignoreHttpStatusErrors, and the full response on request.
 */
async function httpRequest(options, log) {
	const url = new URL(
		options.baseURL ? `${options.baseURL.replace(/\/+$/, '')}${options.url}` : options.url,
	);
	for (const [key, value] of Object.entries(options.qs ?? {})) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	const method = (options.method ?? 'GET').toUpperCase();
	const headers = { ...(options.headers ?? {}) };
	let body;
	if (options.body !== undefined && method !== 'GET') {
		if (Buffer.isBuffer(options.body) || typeof options.body === 'string') {
			body = options.body;
		} else {
			body = JSON.stringify(options.body);
			if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
		}
	}
	if (options.json && !hasHeader(headers, 'accept')) headers.accept = 'application/json';
	const response = await fetch(url, { method, headers, body });
	const raw = Buffer.from(await response.arrayBuffer());
	let data = raw.toString('utf8');
	try {
		data = JSON.parse(data);
	} catch {
		// not JSON: the text, as axios leaves it
	}
	log?.push({
		method,
		url: url.toString(),
		status: response.status,
		headers,
		bodyBytes: body ? body.length : 0,
	});
	if (!options.ignoreHttpStatusErrors && response.status >= 400) {
		const error = new Error(`Request failed with status code ${response.status}`);
		error.response = { status: response.status, data };
		throw error;
	}
	if (options.returnFullResponse) {
		return {
			body: data,
			headers: Object.fromEntries(response.headers.entries()),
			statusCode: response.status,
			statusMessage: response.statusText,
		};
	}
	return data;
}

/** this.helpers.httpRequestWithAuthentication: the credential's generic authentication (headers), then httpRequest */
function authenticatedRequest(node, credentials, log) {
	return async function (type, requestOptions) {
		if (type !== credentialType.name) throw new Error(`Unexpected credential type ${type}`);
		const options = { ...requestOptions, headers: { ...(requestOptions.headers ?? {}) } };
		for (const [section, values] of Object.entries(credentialType.authenticate.properties)) {
			options[section] = { ...(options[section] ?? {}) };
			for (const [key, value] of Object.entries(values))
				options[section][key] = resolveCredentialValue(value, credentials);
		}
		try {
			return await httpRequest(options, log);
		} catch (error) {
			throw new NodeApiError(node, error);
		}
	};
}

/** The credential test n8n runs when the credential is saved: the test request plus its rules */
async function testCredential(data) {
	const credentials = credentialsWith(data);
	const { request, rules = [] } = credentialType.test;
	const options = {
		...request,
		baseURL: resolveCredentialValue(request.baseURL, credentials),
		ignoreHttpStatusErrors: true,
		returnFullResponse: true,
		json: true,
	};
	const response = await authenticatedRequest({ name: 'credential test' }, credentials)(
		credentialType.name,
		options,
	);
	for (const rule of rules) {
		if (rule.type === 'responseCode' && response.statusCode === rule.properties.value) {
			return { status: 'Error', message: rule.properties.message };
		}
	}
	if (response.statusCode >= 400) {
		return {
			status: 'Error',
			message: `HTTP ${response.statusCode}: ${JSON.stringify(response.body)}`,
		};
	}
	return { status: 'OK', message: 'Connection tested successfully', body: response.body };
}

function nodeOf(nodeType, parameters, settings = {}) {
	const description = nodeType.description;
	const node = {
		id: 'node-1',
		name: description.defaults.name,
		type: `n8n-nodes-printandmailcompany.${description.name}`,
		typeVersion: 1,
		position: [0, 0],
		parameters,
		...settings,
	};
	node.parameters = NodeHelpers.getNodeParameters(
		description.properties,
		parameters,
		true,
		false,
		node,
		description,
	);
	return node;
}

function getParameter(node, name, fallback, options = {}) {
	let value = name
		.split('.')
		.reduce(
			(obj, key) => (obj === undefined || obj === null ? undefined : obj[key]),
			node.parameters,
		);
	if (value === undefined) value = fallback;
	if (options.extractValue && value && typeof value === 'object' && '__rl' in value)
		value = value.value;
	return value;
}

function commonContext(node, credentials, log, mode) {
	return {
		getNode: () => node,
		getMode: () => mode,
		getCredentials: async (type) => {
			if (type !== credentialType.name) throw new Error(`Unexpected credential type ${type}`);
			return credentials;
		},
		helpers: { httpRequestWithAuthentication: authenticatedRequest(node, credentials, log) },
	};
}

/**
 * Runs the action node on input items. `items`: [{ json, binary: { data: { data: base64, fileName, mimeType } } }].
 * `onError: 'continueRegularOutput'` for continue on fail. Returns the output items and the requests made.
 */
async function execute({ parameters, credentials, items = [{ json: {} }], onError }) {
	const nodeType = new PrintAndMailCompany();
	const node = nodeOf(nodeType, parameters, onError ? { onError } : {});
	const log = [];
	const context = {
		...commonContext(node, credentialsWith(credentials), log, 'manual'),
		getInputData: () => items,
		getNodeParameter: (name, itemIndex, fallback, options) =>
			getParameter(node, name, fallback, options),
		continueOnFail: () =>
			node.onError === 'continueRegularOutput' || node.onError === 'continueErrorOutput',
	};
	context.helpers.assertBinaryData = (itemIndex, propertyName) => {
		const binary = items[itemIndex]?.binary?.[propertyName];
		if (!binary) {
			throw new NodeOperationError(
				node,
				`This operation expects the node's input data to contain a binary file '${propertyName}', but none was found [item ${itemIndex}]`,
				{ itemIndex },
			);
		}
		return binary;
	};
	context.helpers.getBinaryDataBuffer = async (itemIndex, propertyName) =>
		Buffer.from(context.helpers.assertBinaryData(itemIndex, propertyName).data, 'base64');
	const [output] = await nodeType.execute.call(context);
	return { output, requests: log };
}

/** A list search of the action node (Country, Letter) */
async function listSearch({ method, filter, credentials }) {
	const nodeType = new PrintAndMailCompany();
	const node = nodeOf(nodeType, { resource: 'letter', operation: 'send' });
	const log = [];
	const context = commonContext(node, credentialsWith(credentials), log, 'manual');
	const result = await nodeType.methods.listSearch[method].call(context, filter);
	return { ...result, requests: log };
}

/** A trigger as n8n keeps it between polls: the same static data every time */
function trigger({ credentials }) {
	const nodeType = new PrintAndMailCompanyTrigger();
	const node = nodeOf(nodeType, {});
	const staticData = {};
	return {
		staticData,
		async poll(mode = 'trigger') {
			const log = [];
			const context = {
				...commonContext(node, credentialsWith(credentials), log, mode),
				getNodeParameter: (name, fallback, options) => getParameter(node, name, fallback, options),
				getWorkflowStaticData: () => staticData,
			};
			const result = await nodeType.poll.call(context);
			return { result, requests: log };
		},
	};
}

module.exports = {
	execute,
	listSearch,
	trigger,
	testCredential,
	credentialType,
	PrintAndMailCompany,
	PrintAndMailCompanyTrigger,
};
