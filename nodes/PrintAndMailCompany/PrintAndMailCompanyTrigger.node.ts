import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	type Api,
	type ApiLetter,
	apiContext,
	apiRequest,
	letterOutput,
	listLetters,
} from './GenericFunctions';

/** Letters per request (the most GET /letters answers at once) and the most pages one poll reads */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** How many ids of posted letters the trigger remembers (the newest), so that each letter starts the workflow once */
const REMEMBERED_IDS = 300;

interface TriggerStaticData extends IDataObject {
	postedLetterIds?: string[];
}

/**
 * The posted letters, most recently posted first, down to the first page that has a letter the trigger already knows.
 * A server that doesn't page (it answers the first page again) ends the list there.
 */
async function recentlyPosted(
	this: IPollFunctions,
	api: Api,
	known: Set<string> | undefined,
): Promise<ApiLetter[]> {
	const letters: ApiLetter[] = [];
	const seen = new Set<string>();
	for (let page = 0, offset = 0; page < MAX_PAGES; page++) {
		const qs: IDataObject = { status: 'posted', limit: PAGE_SIZE };
		if (offset > 0) qs.offset = offset;
		const response = await apiRequest.call(this, api, 'GET', '/letters', { qs });
		const batch = (response.letters as ApiLetter[] | undefined) ?? [];
		const fresh = batch.filter((letter) => !seen.has(letter.id));
		for (const letter of fresh) {
			seen.add(letter.id);
			letters.push(letter);
		}
		const reachedKnown = !known || batch.some((letter) => known.has(letter.id));
		if (reachedKnown || batch.length < PAGE_SIZE || fresh.length === 0) break;
		offset += batch.length;
	}
	return letters;
}

export class PrintAndMailCompanyTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Print and Mail Company Trigger',
		name: 'printAndMailCompanyTrigger',
		icon: { light: 'file:printAndMailCompany.svg', dark: 'file:printAndMailCompany.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: 'Letter Posted',
		description: 'Triggers when a letter has been posted',
		defaults: {
			name: 'Print and Mail Company Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'printAndMailCompanyApi',
				required: true,
			},
		],
		properties: [
			{
				// The editor lists the trigger by this event ("On letter posted") next to the node's actions
				displayName: 'Trigger On',
				name: 'event',
				type: 'options',
				required: true,
				noDataExpression: true,
				default: 'letterPosted',
				options: [
					{
						name: 'Letter Posted',
						value: 'letterPosted',
						description: 'Triggers when a letter has been posted',
					},
				],
			},
		],
	};

	/**
	 * Letter Posted: every letter posted since the last poll, one item each, in the order they were posted. The first
	 * poll after activation remembers the letters posted so far and starts nothing. A manual test run shows the most
	 * recently posted letter.
	 */
	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const event = this.getNodeParameter('event', 'letterPosted') as string;
		if (event !== 'letterPosted') {
			throw new NodeOperationError(this.getNode(), `The event '${event}' is not supported`);
		}
		const api = await apiContext.call(this);

		if (this.getMode() === 'manual') {
			const [latest] = await listLetters.call(this, api, { status: 'posted', max: 1 });
			if (!latest) {
				throw new NodeOperationError(
					this.getNode(),
					'No letter has been posted from this account yet',
					{
						description:
							'Once a letter has been posted, fetch a test event again. When the workflow is active, every letter posted from then on starts it.',
					},
				);
			}
			return [[{ json: letterOutput(latest) }]];
		}

		const staticData = this.getWorkflowStaticData('node') as TriggerStaticData;
		const known = Array.isArray(staticData.postedLetterIds)
			? new Set(staticData.postedLetterIds)
			: undefined;
		const posted = await recentlyPosted.call(this, api, known);

		const remembered = [...posted.map((letter) => letter.id), ...(staticData.postedLetterIds ?? [])]
			.filter((id, index, ids) => ids.indexOf(id) === index)
			.slice(0, REMEMBERED_IDS);
		if (remembered.join() !== (staticData.postedLetterIds ?? []).join() || !known) {
			staticData.postedLetterIds = remembered;
		}

		if (!known) return null;
		const fresh = posted.filter((letter) => !known.has(letter.id)).reverse();
		if (fresh.length === 0) return null;
		return [fresh.map((letter) => ({ json: letterOutput(letter) }))];
	}
}
