import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	type Api,
	type ApiLetter,
	apiContext,
	apiRequest,
	destinations,
	friendlyMessage,
	letterOutput,
	listLetters,
	printOptionsFrom,
	recipientFrom,
	sendDraft,
	sendNow,
	text,
	uploadPdf,
} from './GenericFunctions';
import { letterFields, letterOperations } from './LetterDescription';

/** The languages a written letter can have (LETTER_LANGUAGES of the app) */
const LANGUAGES = ['en', 'de', 'fr', 'es', 'pt', 'it', 'nl'];

const STATUS_LABELS: Record<string, string> = {
	draft: 'Draft',
	paid: 'Paid',
	in_production: 'In production',
	printed: 'Printed',
	posted: 'Posted',
	cancelled: 'Cancelled',
	returned: 'Returned',
};

/** Send: uploads the PDF (print check), creates the draft and, with "Send now: Yes", pays it from credit */
async function sendLetter(
	this: IExecuteFunctions,
	api: Api,
	itemIndex: number,
): Promise<ApiLetter> {
	// Checked before anything is uploaded or created
	const send = sendNow.call(this, itemIndex);
	const recipient = await recipientFrom.call(this, api, itemIndex);

	const document = await uploadPdf.call(this, api, itemIndex);
	// The paper choice only counts for a US Letter PDF to a country outside the US, Canada and US territories
	const paperSize =
		text(this.getNodeParameter('paperSize', itemIndex, 'a4')) === 'us_letter' ? 'us_letter' : 'a4';
	const draft = (await apiRequest.call(this, api, 'POST', '/letters', {
		body: {
			documentId: document.id,
			recipient,
			...printOptionsFrom.call(this, itemIndex),
			paperSize,
		},
		itemIndex,
	})) as unknown as ApiLetter;
	if (!send) return draft;

	// A PDF that needs adjusting is never changed without the account holder: it waits as a draft
	if (!document.compliant) {
		throw new NodeOperationError(
			this.getNode(),
			`${friendlyMessage(422, { code: 'DOCUMENT_NOT_COMPLIANT' }, api.links)} The letter ${draft.reference} was saved as a draft: open ${draft.url} to adjust the PDF, then send it.`,
			{ itemIndex },
		);
	}
	return await sendDraft.call(this, api, draft, itemIndex);
}

/** Write: composes the letter from the text (the account's own sender block, as on the website) and sends it like Send */
async function writeLetter(
	this: IExecuteFunctions,
	api: Api,
	itemIndex: number,
): Promise<ApiLetter> {
	const send = sendNow.call(this, itemIndex);
	const recipient = await recipientFrom.call(this, api, itemIndex);
	const language = text(this.getNodeParameter('language', itemIndex, 'en')).toLowerCase();
	const closing = text(this.getNodeParameter('closing', itemIndex, ''));
	const signature = text(this.getNodeParameter('signature', itemIndex, ''));
	const body: IDataObject = {
		recipient,
		subject: text(this.getNodeParameter('subject', itemIndex, '')),
		body: text(this.getNodeParameter('text', itemIndex, '')),
		language: LANGUAGES.includes(language) ? language : 'en',
		...(closing ? { closing } : {}),
		...(signature ? { signature } : {}),
		...printOptionsFrom.call(this, itemIndex),
	};
	const composed = await apiRequest.call(this, api, 'POST', '/compose', { body, itemIndex });
	const letter = composed.letter as unknown as ApiLetter;
	if (!send) return letter;
	return await sendDraft.call(this, api, letter, itemIndex);
}

async function getLetter(this: IExecuteFunctions, api: Api, itemIndex: number): Promise<ApiLetter> {
	const letterId = text(this.getNodeParameter('letterId', itemIndex, '', { extractValue: true }));
	if (!letterId) {
		throw new NodeOperationError(this.getNode(), "Choose the letter in 'Letter', or enter its ID", {
			itemIndex,
		});
	}
	return (await apiRequest.call(this, api, 'GET', `/letters/${encodeURIComponent(letterId)}`, {
		itemIndex,
	})) as unknown as ApiLetter;
}

async function getManyLetters(
	this: IExecuteFunctions,
	api: Api,
	itemIndex: number,
): Promise<ApiLetter[]> {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll
		? Infinity
		: Math.max(1, Math.floor(this.getNodeParameter('limit', itemIndex, 50) as number));
	const filters = this.getNodeParameter('filters', itemIndex, {}) as { status?: string };
	return await listLetters.call(this, api, {
		status: filters.status || undefined,
		max: limit,
		itemIndex,
	});
}

export class PrintAndMailCompany implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Print and Mail Company',
		name: 'printAndMailCompany',
		icon: { light: 'file:printAndMailCompany.svg', dark: 'file:printAndMailCompany.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Send PDFs and typed letters by post, printed and posted for you',
		defaults: {
			name: 'Print and Mail Company',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'printAndMailCompanyApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Letter',
						value: 'letter',
					},
				],
				default: 'letter',
			},
			...letterOperations,
			...letterFields,
		],
	};

	methods = {
		listSearch: {
			/** The countries letters go to, for the Country list */
			async searchCountries(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const api = await apiContext.call(this, false);
				const wanted = (filter ?? '').trim().toLowerCase();
				const results = (await destinations.call(this, api))
					.filter(
						(d) =>
							!wanted || d.name.toLowerCase().includes(wanted) || d.code.toLowerCase() === wanted,
					)
					.sort((a, b) => a.name.localeCompare(b.name, 'en'))
					.map((d) => ({ name: d.name, value: d.code }));
				return { results };
			},

			/** The account's 100 most recent letters, for the Letter list */
			async searchLetters(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const api = await apiContext.call(this, false);
				const wanted = (filter ?? '').trim().toLowerCase();
				const results = (await listLetters.call(this, api, { max: 100 }))
					.filter(
						(l) =>
							!wanted ||
							[l.id, l.reference, l.recipient?.name, l.recipient?.company].some((v) =>
								String(v ?? '')
									.toLowerCase()
									.includes(wanted),
							),
					)
					.map((l) => ({
						name: `${l.reference} · ${l.recipient?.name ?? ''} · ${STATUS_LABELS[l.status] ?? l.status}`,
						value: l.id,
						url: l.url,
					}));
				return { results };
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const api = await apiContext.call(this);

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				if (operation === 'getAll') {
					const letters = await getManyLetters.call(this, api, itemIndex);
					for (const letter of letters) {
						returnData.push({ json: letterOutput(letter), pairedItem: { item: itemIndex } });
					}
					continue;
				}
				let letter: ApiLetter;
				if (operation === 'send') {
					letter = await sendLetter.call(this, api, itemIndex);
				} else if (operation === 'write') {
					letter = await writeLetter.call(this, api, itemIndex);
				} else if (operation === 'get') {
					letter = await getLetter.call(this, api, itemIndex);
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`The operation '${operation}' is not supported`,
						{
							itemIndex,
						},
					);
				}
				returnData.push({ json: letterOutput(letter), pairedItem: { item: itemIndex } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				// Errors from the API keep their HTTP status; everything else keeps its message and item
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}
