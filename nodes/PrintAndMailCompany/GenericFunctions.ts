import { randomBytes } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	INode,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

export type Context = IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions;

export const CREDENTIALS_TYPE = 'printAndMailCompanyApi';

const PRODUCTION_URL = 'https://printandmailcompany.com';

/**
 * Largest PDF sent as an upload: requests to our API are limited to about 4.5 MB, and the account's limit is 4 MB at
 * the moment. A larger file is refused with a message that says how to make it smaller.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Letters per request: the most GET /letters answers at once */
const PAGE_SIZE = 100;

/** How often an upload is tried again while the server is busy with other PDFs (503), and the longest wait in seconds */
const BUSY_RETRIES = 2;
const MAX_BUSY_WAIT_SECONDS = 30;

/**
 * An API key takes a limited number of requests in a row: then the API refuses it until a minute passes without
 * requests (401, like a revoked key, or 429 with Retry-After). A key that worked earlier in the same run waits that
 * minute once and tries again, so a large batch doesn't stop halfway.
 */
const KEY_PAUSE_SECONDS = 61;

/** Pages in the account that error messages point to (the English pages; the site switches language) */
export interface Links {
	apiKeys: string;
	settings: string;
	wallet: string;
}

/** Where the API is, from the credential, and what one execution already loaded from it */
export interface Api {
	baseUrl: string;
	links: Links;
	/** Waits and tries again when the server is busy or the key is over its limit (runs, not the editor's lists) */
	patient: boolean;
	/** The API accepted the key in this run */
	keyAccepted?: boolean;
	destinations?: Destination[];
}

export interface Destination {
	code: string;
	name: string;
}

/** A letter as the API returns it (serializeLetter of the app, plus url) */
export interface ApiLetter {
	id: string;
	reference: string;
	status: string;
	recipient?: { name?: string; company?: string; country?: string };
	recipientLines?: string[];
	options?: { pages?: number; color?: string; duplex?: boolean; registered?: boolean };
	currency?: string;
	total?: number;
	totalFormatted?: string;
	priceLabel?: string;
	trackingNumber?: string | null;
	createdAt?: string | null;
	paidAt?: string | null;
	postedAt?: string | null;
	url?: string;
}

/** A document as the API returns it after an upload, with the print check */
export interface ApiDocument {
	id: string;
	compliant: boolean;
}

interface ApiErrorBody {
	code?: string;
	message?: string;
	details?: unknown;
}

/** `patient`: for workflow runs and polls, which may wait; the editor's lists answer at once */
export async function apiContext(this: Context, patient = true): Promise<Api> {
	const credentials = await this.getCredentials(CREDENTIALS_TYPE);
	const baseUrl =
		String(credentials.baseUrl || PRODUCTION_URL)
			.trim()
			.replace(/\/+$/, '') || PRODUCTION_URL;
	return {
		baseUrl,
		patient,
		links: {
			apiKeys: `${baseUrl}/en/app/developers`,
			settings: `${baseUrl}/en/app/settings`,
			wallet: `${baseUrl}/en/app/wallet`,
		},
	};
}

export interface RequestOptions {
	qs?: IDataObject;
	body?: IDataObject;
	/** A PDF, sent as the multipart field "file" */
	file?: { data: Buffer; fileName: string };
	itemIndex?: number;
	/** Added to the message when the request is refused, e.g. where the draft is */
	suffix?: string;
}

/** A request to the REST API (/api/v1) with the credential's API key; refusals become messages a workflow owner can act on */
export async function apiRequest(
	this: Context,
	api: Api,
	method: IHttpRequestMethods,
	path: string,
	options: RequestOptions = {},
): Promise<IDataObject> {
	const request: IHttpRequestOptions = {
		method,
		url: `${api.baseUrl}/api/v1${path}`,
		json: true,
		ignoreHttpStatusErrors: true,
		returnFullResponse: true,
	};
	if (options.qs) request.qs = options.qs;
	if (options.file) {
		const boundary = `----PrintAndMailCompany${randomBytes(12).toString('hex')}`;
		request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
		request.body = multipartBody(boundary, options.file);
	} else if (options.body) {
		request.body = options.body;
	}

	let busyRetries = 0;
	let keyPaused = false;
	for (;;) {
		const response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIALS_TYPE,
			request,
		)) as IN8nHttpFullResponse;
		const body = parseBody(response.body);
		const status = response.statusCode;
		if (status < 400) {
			api.keyAccepted = true;
			return body;
		}
		if (api.patient) {
			const retryAfter = retryAfterSeconds(response, body);
			// No PDF worker was free in time: nothing was created, so the same request is sent again shortly
			if (status === 503 && busyRetries < BUSY_RETRIES) {
				busyRetries++;
				await sleep(Math.min(retryAfter ?? 10, MAX_BUSY_WAIT_SECONDS) * 1000);
				continue;
			}
			// Refused before anything was done (the key over its limit), so the same request is sent again after the pause
			const pause =
				status === 401 && api.keyAccepted
					? KEY_PAUSE_SECONDS
					: status === 429 && retryAfter !== undefined && retryAfter <= KEY_PAUSE_SECONDS
						? retryAfter
						: undefined;
			if (pause !== undefined && !keyPaused) {
				keyPaused = true;
				await sleep(pause * 1000);
				continue;
			}
		}
		throw apiError(this.getNode(), api, status, body, options);
	}
}

/** One multipart/form-data body with the PDF as "file", as the website's upload sends it */
function multipartBody(boundary: string, file: { data: Buffer; fileName: string }): Buffer {
	const fileName = file.fileName.replace(/["\\]/g, '_');
	return Buffer.concat([
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/pdf\r\n\r\n`,
			'utf8',
		),
		file.data,
		Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
	]);
}

function parseBody(body: unknown): IDataObject {
	if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body as IDataObject;
	const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : '';
	if (!text.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === 'object' ? (parsed as IDataObject) : { message: text };
	} catch {
		return { message: text.slice(0, 500) };
	}
}

/** The wait in seconds the API asks for (details.retryAfterSeconds or Retry-After), if it names one */
function retryAfterSeconds(response: IN8nHttpFullResponse, body: IDataObject): number | undefined {
	const details = (body.error as IDataObject | undefined)?.details as IDataObject | undefined;
	const seconds =
		Number(details?.retryAfterSeconds) || Number((response.headers ?? {})['retry-after']);
	return seconds > 0 ? Math.ceil(seconds) : undefined;
}

/** Address fields as the API names them (INVALID_ADDRESS details.fields), as the operations label them */
const ADDRESS_LABELS: Record<string, string> = {
	name: 'Recipient Name',
	company: 'Company or Organisation',
	line1: 'Street Address',
	line2: 'Additional Address Line',
	postalCode: 'Postcode or ZIP Code',
	city: 'City or Town',
	region: 'State, Province or Region',
	country: 'Country',
};
const PROBLEMS: Record<string, string> = {
	required: 'missing',
	invalid: 'not valid',
	tooLong: 'too long',
};
/** Other fields of the operations, by the API's names (INVALID_REQUEST details[].path) */
const FIELD_LABELS: Record<string, string> = {
	subject: 'Subject',
	body: 'Letter Text',
	closing: 'Closing',
	signature: 'Name Under the Closing',
	language: 'Language of the Letter',
};

/** One problem of INVALID_REQUEST (a zod issue: path "recipient.city", message "Too small: …") in the operations' words */
function requestProblem(issue: unknown): string {
	const { path, message } = (issue ?? {}) as { path?: unknown; message?: unknown };
	const field = String(path ?? '');
	const text = String(message ?? '');
	const label = field.startsWith('recipient.')
		? ADDRESS_LABELS[field.slice('recipient.'.length)]
		: FIELD_LABELS[field];
	if (!label) return field ? `${field}: ${text}` : text;
	const problem = /too small/i.test(text)
		? 'missing'
		: /too big/i.test(text)
			? 'too long'
			: 'not valid';
	return `${label} (${problem})`;
}

/** What went wrong, in words a workflow owner can act on */
export function friendlyMessage(status: number, error: ApiErrorBody, links: Links): string {
	const { code, message, details } = error;
	switch (code) {
		case 'INSUFFICIENT_FUNDS':
			return `There isn't enough credit in your account to pay for this letter. Top up your credit at ${links.wallet} and try again.`;
		case 'SENDER_DETAILS_REQUIRED':
			return `Your account needs your sender details first: your real full name and postal address, which every envelope shows as the sender. Add them under Your details in your account settings (${links.settings}) and try again.`;
		case 'PAPER_CHOICE_REQUIRED':
			return "The PDF is US Letter size and the recipient lives outside the US, Canada and US territories. Choose the paper in 'Paper Size for US Letter PDFs': shrink to A4 (recommended) or keep US Letter.";
		case 'INVALID_ADDRESS': {
			const fields = ((details as IDataObject | undefined)?.fields ?? {}) as Record<string, string>;
			const list = Object.entries(fields).map(
				([field, problem]) => `${ADDRESS_LABELS[field] ?? field} (${PROBLEMS[problem] ?? problem})`,
			);
			return list.length
				? `The recipient's address is incomplete or not valid: ${list.join(', ')}.`
				: "The recipient's address is incomplete or not valid.";
		}
		case 'INVALID_REQUEST': {
			const list = Array.isArray(details) ? details.map(requestProblem).filter(Boolean) : [];
			return list.length
				? `Some fields are missing or not valid: ${list.join(', ')}.`
				: 'Some fields are missing or not valid.';
		}
		case 'EMAIL_NOT_VERIFIED':
			return 'Please confirm your email address first: open the confirmation email we sent you, or request a new one in your account.';
		case 'DOCUMENT_NOT_COMPLIANT':
			return 'The PDF needs adjusting before it can be printed: some content is too close to the edge of the page, or a page is neither A4 nor US Letter.';
		default:
			return message || `Print and Mail Company didn't accept the request (HTTP ${status}).`;
	}
}

/** The error for a refused request: an API key that no longer works, a busy server, or a message from friendlyMessage */
function apiError(
	node: INode,
	api: Api,
	status: number,
	body: IDataObject,
	options: RequestOptions,
): NodeApiError {
	const error = (body.error && typeof body.error === 'object' ? body.error : {}) as ApiErrorBody;
	let message: string;
	if (status === 401) {
		message = `Print and Mail Company didn't accept the API key. If it was revoked or deleted, create a new key under API & AI assistants in your account (${api.links.apiKeys}) and enter it in your Print and Mail Company credential. If the workflow sent many requests just before, wait a minute and run it again.`;
	} else if (status === 503) {
		message = 'The server is busy with other PDFs. Wait a moment and run the workflow again.';
	} else if (status === 429) {
		message =
			'There were too many requests in a short time. Wait a while and run the workflow again.';
	} else {
		message = friendlyMessage(status, error, api.links);
	}
	return new NodeApiError(node, body as JsonObject, {
		message: `${message}${options.suffix ?? ''}`,
		description: error.code ? `${error.code}: ${error.message ?? ''}`.trim() : undefined,
		httpCode: String(status),
		itemIndex: options.itemIndex,
	});
}

/**
 * A letter as the nodes give it to the next nodes: flat and with the same keys every time, as the Zapier app gives it
 * (integrations/zapier/lib/letters.js letterOutput).
 */
export function letterOutput(letter: ApiLetter): IDataObject {
	const recipient = letter.recipient ?? {};
	const options = letter.options ?? {};
	return {
		id: letter.id,
		reference: letter.reference,
		status: letter.status,
		recipient_name: recipient.name ?? '',
		recipient_company: recipient.company ?? '',
		recipient_address: (letter.recipientLines ?? []).join('\n'),
		recipient_country: recipient.country ?? '',
		pages: options.pages ?? null,
		printing: options.color === 'color' ? 'Colour' : 'Black & white',
		double_sided: Boolean(options.duplex),
		registered: Boolean(options.registered),
		total: letter.totalFormatted ?? '',
		total_amount: typeof letter.total === 'number' ? letter.total / 100 : null,
		currency: letter.currency ?? '',
		price_note: letter.priceLabel ?? '',
		tracking_number: letter.trackingNumber ?? '',
		created_at: letter.createdAt ?? null,
		paid_at: letter.paidAt ?? null,
		posted_at: letter.postedAt ?? null,
		url: letter.url ?? '',
	};
}

/**
 * Letters, newest first (posted letters newest posted first), up to `max`. Pages through the list with offset; a server
 * that answers the first page again (no paging) ends the list there.
 */
export async function listLetters(
	this: Context,
	api: Api,
	options: { status?: string; max: number; itemIndex?: number },
): Promise<ApiLetter[]> {
	const letters: ApiLetter[] = [];
	const seen = new Set<string>();
	let offset = 0;
	while (letters.length < options.max) {
		const limit = Math.min(PAGE_SIZE, options.max - letters.length);
		const qs: IDataObject = { limit };
		if (options.status) qs.status = options.status;
		if (offset > 0) qs.offset = offset;
		const response = await apiRequest.call(this, api, 'GET', '/letters', {
			qs,
			itemIndex: options.itemIndex,
		});
		const page = (response.letters as ApiLetter[] | undefined) ?? [];
		const fresh = page.filter((letter) => !seen.has(letter.id));
		for (const letter of fresh) {
			seen.add(letter.id);
			letters.push(letter);
		}
		if (page.length < limit || fresh.length === 0) break;
		offset += page.length;
	}
	return letters.slice(0, options.max);
}

/** The countries letters go to (public list, loaded once per execution) */
export async function destinations(
	this: Context,
	api: Api,
	itemIndex?: number,
): Promise<Destination[]> {
	if (!api.destinations) {
		const response = await apiRequest.call(this, api, 'GET', '/destinations', { itemIndex });
		api.destinations = ((response.destinations as Destination[] | undefined) ?? []).map((d) => ({
			code: d.code,
			name: d.name,
		}));
	}
	return api.destinations;
}

/** Common English names and abbreviations the destination list doesn't use */
const COUNTRY_ALIASES: Record<string, string> = {
	usa: 'US',
	'united states of america': 'US',
	america: 'US',
	uk: 'GB',
	'great britain': 'GB',
	britain: 'GB',
	england: 'GB',
	scotland: 'GB',
	wales: 'GB',
	'northern ireland': 'GB',
	holland: 'NL',
	'the netherlands': 'NL',
};

const fold = (s: string) =>
	s
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z ]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

export const text = (value: unknown): string =>
	value === null || value === undefined ? '' : String(value).trim();

/**
 * The ISO code of the country given as a code (de, DE) or an English name (Germany, United States). The aliases come
 * first, so that UK (not an ISO code) is the United Kingdom (GB).
 */
export async function resolveCountry(
	this: IExecuteFunctions,
	api: Api,
	value: unknown,
	itemIndex: number,
): Promise<string> {
	const raw = text(value);
	if (!raw) {
		throw new NodeOperationError(
			this.getNode(),
			"Choose the country the letter goes to in 'Country'",
			{ itemIndex },
		);
	}
	const wanted = fold(raw);
	if (COUNTRY_ALIASES[wanted]) return COUNTRY_ALIASES[wanted];
	if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
	if (wanted) {
		const match = (await destinations.call(this, api, itemIndex)).find(
			(d) => fold(d.name) === wanted,
		);
		if (match) return match.code;
	}
	throw new NodeOperationError(
		this.getNode(),
		`'${raw}' is not a country we recognise. Choose it from the list in 'Country', or use its two-letter code, for example DE or US.`,
		{ itemIndex },
	);
}

const truthy = (value: unknown) => value === true || /^(true|yes|y|1|on)$/i.test(text(value));

/** The recipient as the API takes it (addressSchema of the app) */
export async function recipientFrom(
	this: IExecuteFunctions,
	api: Api,
	itemIndex: number,
): Promise<IDataObject> {
	const get = (name: string) => text(this.getNodeParameter(name, itemIndex, ''));
	const country = this.getNodeParameter('country', itemIndex, '', { extractValue: true });
	return {
		name: get('recipientName'),
		company: get('recipientCompany') || undefined,
		line1: get('addressLine1'),
		line2: get('addressLine2') || undefined,
		postalCode: get('postalCode') || undefined,
		city: get('city'),
		region: get('region') || undefined,
		country: await resolveCountry.call(this, api, country, itemIndex),
	};
}

/** How it is printed and posted. The envelope is chosen for the number of pages. */
export function printOptionsFrom(this: IExecuteFunctions, itemIndex: number): IDataObject {
	const color = text(this.getNodeParameter('color', itemIndex, 'bw')).toLowerCase();
	return {
		color: color === 'color' || color === 'colour' ? 'color' : 'bw',
		duplex: truthy(this.getNodeParameter('doubleSided', itemIndex, false)),
		registered: truthy(this.getNodeParameter('registered', itemIndex, false)),
	};
}

/** The same wording as the checkbox before paying on the website (the Zapier app's "Send now" field) */
export const SEND_NOW_YES =
	'Yes: I accept the Terms & Conditions and ask you to start printing immediately. I understand that my right of withdrawal ends once the letter has been printed.';
export const SEND_NOW_NO = 'No: save as a draft to check and send in my account';

/** "yes" or "no"; anything else is refused, so that sending is always an explicit choice */
export function sendNow(this: IExecuteFunctions, itemIndex: number): boolean {
	const value = text(this.getNodeParameter('sendNow', itemIndex, '')).toLowerCase();
	if (value === 'yes' || value === SEND_NOW_YES.toLowerCase()) return true;
	if (value === 'no' || value === SEND_NOW_NO.toLowerCase()) return false;
	throw new NodeOperationError(this.getNode(), "Choose 'Yes' or 'No' in 'Send Now'", { itemIndex });
}

/**
 * Pays a draft from the account's credit and releases it to print ("Send now": the workflow owner accepted the terms
 * and asked for printing to start at once). A refusal (no credit, no sender details…) says where the draft is.
 */
export async function sendDraft(
	this: IExecuteFunctions,
	api: Api,
	draft: ApiLetter,
	itemIndex: number,
): Promise<ApiLetter> {
	return (await apiRequest.call(
		this,
		api,
		'POST',
		`/letters/${encodeURIComponent(draft.id)}/send`,
		{
			body: { acceptTerms: true },
			itemIndex,
			suffix: ` The letter ${draft.reference} was saved as a draft: ${draft.url}`,
		},
	)) as unknown as ApiLetter;
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The file's name for the account's document list: without characters file systems refuse, up to 120 characters */
export function pdfFileName(name: string | undefined): string {
	const cleaned = Array.from(name ?? '')
		.map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? ' ' : c))
		.join('')
		.trim()
		.slice(0, 120);
	return cleaned || 'document.pdf';
}

/** Uploads the PDF of the input binary field to the account, which runs the print check */
export async function uploadPdf(
	this: IExecuteFunctions,
	api: Api,
	itemIndex: number,
): Promise<ApiDocument> {
	const binaryPropertyName =
		text(this.getNodeParameter('binaryPropertyName', itemIndex, 'data')) || 'data';
	const binary = this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
	const data = await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);
	if (data.length === 0) {
		throw new NodeOperationError(
			this.getNode(),
			`The file in the binary field '${binaryPropertyName}' is empty`,
			{
				itemIndex,
			},
		);
	}
	if (data.length > MAX_UPLOAD_BYTES) {
		throw new NodeOperationError(
			this.getNode(),
			`This PDF is ${megabytes(data.length)}. Letters can be sent from PDFs of up to ${megabytes(MAX_UPLOAD_BYTES)}: save it as a smaller PDF (for example with lower image quality) and try again.`,
			{ itemIndex },
		);
	}
	return (await apiRequest.call(this, api, 'POST', '/documents', {
		file: { data, fileName: pdfFileName(binary.fileName) },
		itemIndex,
	})) as unknown as ApiDocument;
}
