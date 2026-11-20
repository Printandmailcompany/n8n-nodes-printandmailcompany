import type { INodeProperties } from 'n8n-workflow';

/**
 * The Letter resource. Send and Write take the fields of the Zapier app's Send Letter and Write Letter actions
 * (integrations/zapier/lib/fields.js, creates/send_letter.js, creates/write_letter.js): the same labels in title case
 * and the same help texts.
 */
export const letterOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['letter'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				description: 'Get a letter',
				action: 'Get a letter',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Get many letters',
				action: 'Get many letters',
			},
			{
				name: 'Send',
				value: 'send',
				description:
					'Sends a PDF as a printed letter by post, or saves it as a draft to check first',
				action: 'Send a letter',
			},
			{
				name: 'Write',
				value: 'write',
				description:
					'Writes a letter from your text and sends it by post, or saves it as a draft to check first',
				action: 'Write a letter',
			},
		],
		default: 'send',
	},
];

const sendAndWrite = { show: { resource: ['letter'], operation: ['send', 'write'] } };
const sendOnly = { show: { resource: ['letter'], operation: ['send'] } };
const writeOnly = { show: { resource: ['letter'], operation: ['write'] } };

export const letterFields: INodeProperties[] = [
	/* -------------------------------------------------------------------------- */
	/*                                letter:send                                 */
	/* -------------------------------------------------------------------------- */
	{
		displayName: 'PDF File',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		placeholder: 'e.g. data',
		displayOptions: sendOnly,
		description:
			'The PDF to print and post: A4 or US Letter pages with a free margin on every side, up to 4 MB. Enter the name of the input binary field that holds it.',
	},

	/* -------------------------------------------------------------------------- */
	/*                        letter:send and letter:write                        */
	/* -------------------------------------------------------------------------- */
	{
		displayName: 'Recipient Name',
		name: 'recipientName',
		type: 'string',
		required: true,
		default: '',
		displayOptions: sendAndWrite,
		description:
			'The person the letter is for, as it should appear on the envelope. Up to 60 characters.',
	},
	{
		displayName: 'Company or Organisation',
		name: 'recipientCompany',
		type: 'string',
		default: '',
		displayOptions: sendAndWrite,
		description: 'Printed under the name. Up to 60 characters.',
	},
	{
		displayName: 'Street Address',
		name: 'addressLine1',
		type: 'string',
		required: true,
		default: '',
		displayOptions: sendAndWrite,
		description: 'Street and house number, or PO box. Up to 60 characters.',
	},
	{
		displayName: 'Additional Address Line',
		name: 'addressLine2',
		type: 'string',
		default: '',
		displayOptions: sendAndWrite,
		description: 'For example c/o, apartment, building or district. Up to 60 characters.',
	},
	{
		displayName: 'Postcode or ZIP Code',
		name: 'postalCode',
		type: 'string',
		default: '',
		displayOptions: sendAndWrite,
		description: 'Needed in most countries',
	},
	{
		displayName: 'City or Town',
		name: 'city',
		type: 'string',
		required: true,
		default: '',
		displayOptions: sendAndWrite,
	},
	{
		displayName: 'State, Province or Region',
		name: 'region',
		type: 'string',
		default: '',
		displayOptions: sendAndWrite,
		description: 'Where the country uses one on letters, for example the state in the US (IL)',
	},
	{
		displayName: 'Country',
		name: 'country',
		type: 'resourceLocator',
		required: true,
		default: { mode: 'list', value: '' },
		displayOptions: sendAndWrite,
		description:
			'The country the letter goes to. A two-letter country code (DE, US) or the country name in English also works when you map it from an earlier step.',
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: {
					searchListMethod: 'searchCountries',
					searchable: true,
				},
			},
			{
				// Not "id": the editor would label it "By ID"
				displayName: 'By Code or Name',
				name: 'code',
				type: 'string',
				placeholder: 'e.g. DE',
			},
		],
	},

	/* -------------------------------------------------------------------------- */
	/*                               letter:write                                 */
	/* -------------------------------------------------------------------------- */
	{
		displayName: 'Subject',
		name: 'subject',
		type: 'string',
		required: true,
		default: '',
		displayOptions: writeOnly,
		description: 'Printed above the text. Up to 200 characters.',
	},
	{
		displayName: 'Letter Text',
		name: 'text',
		type: 'string',
		required: true,
		default: '',
		typeOptions: { rows: 8 },
		displayOptions: writeOnly,
		description:
			'Start with the salutation, for example "Dear Sir or Madam,", and leave a blank line between paragraphs. We add the date, the closing and your name. Your sender details are printed in the letter and on the envelope. Up to 20,000 characters.',
	},
	{
		displayName: 'Language of the Letter',
		name: 'language',
		type: 'options',
		default: 'en',
		displayOptions: writeOnly,
		description: 'Sets the date format and the closing',
		options: [
			{ name: 'Dutch', value: 'nl' },
			{ name: 'English', value: 'en' },
			{ name: 'French', value: 'fr' },
			{ name: 'German', value: 'de' },
			{ name: 'Italian', value: 'it' },
			{ name: 'Portuguese', value: 'pt' },
			{ name: 'Spanish', value: 'es' },
		],
	},
	{
		displayName: 'Closing',
		name: 'closing',
		type: 'string',
		default: '',
		displayOptions: writeOnly,
		description:
			'For example "Kind regards". Leave it empty for the usual closing in the letter\'s language.',
	},
	{
		displayName: 'Name Under the Closing',
		name: 'signature',
		type: 'string',
		default: '',
		displayOptions: writeOnly,
		description: 'Leave it empty for your name from Your details',
	},

	/* -------------------------------------------------------------------------- */
	/*                        letter:send and letter:write                        */
	/* -------------------------------------------------------------------------- */
	{
		displayName: 'Printing',
		name: 'color',
		type: 'options',
		default: 'bw',
		displayOptions: sendAndWrite,
		options: [
			{ name: 'Black & White', value: 'bw' },
			{ name: 'Colour', value: 'color' },
		],
	},
	{
		displayName: 'Double-Sided',
		name: 'doubleSided',
		type: 'boolean',
		default: false,
		displayOptions: sendAndWrite,
	},
	{
		displayName: 'Registered Mail',
		name: 'registered',
		type: 'boolean',
		default: false,
		displayOptions: sendAndWrite,
		hint: 'With a tracking number and a signature on delivery.',
	},
	{
		displayName: 'Paper Size for US Letter PDFs',
		name: 'paperSize',
		type: 'options',
		default: 'a4',
		displayOptions: sendOnly,
		description:
			'Only used for a US Letter PDF sent outside the US, Canada and US territories. The price is the same.',
		options: [
			{ name: 'Shrink to A4 (Recommended)', value: 'a4' },
			{ name: 'Keep US Letter', value: 'us_letter' },
		],
	},
	{
		displayName: 'Send Now',
		name: 'sendNow',
		type: 'options',
		required: true,
		default: 'no',
		displayOptions: sendAndWrite,
		description:
			'Yes pays the letter from your prepaid credit and releases it to print (<a href="https://printandmailcompany.com/en/legal/terms">Terms & Conditions</a>). No saves a draft with the exact price, which you check and send in your account.',
		options: [
			{
				name: 'Yes',
				value: 'yes',
				description:
					'I accept the Terms & Conditions and ask you to start printing immediately. I understand that my right of withdrawal ends once the letter has been printed.',
			},
			{
				name: 'No',
				value: 'no',
				description: 'Save as a draft to check and send in my account',
			},
		],
	},
	{
		// The whole wording of "Yes" under the field: the editor's list shows only two lines of an option's description
		displayName:
			'Yes: I accept the Terms & Conditions and ask you to start printing immediately. I understand that my right of withdrawal ends once the letter has been printed.',
		name: 'sendNowConsent',
		type: 'notice',
		default: '',
		displayOptions: {
			show: { resource: ['letter'], operation: ['send', 'write'], sendNow: ['yes'] },
		},
	},

	/* -------------------------------------------------------------------------- */
	/*                                 letter:get                                 */
	/* -------------------------------------------------------------------------- */
	{
		displayName: 'Letter',
		name: 'letterId',
		type: 'resourceLocator',
		required: true,
		default: { mode: 'list', value: '' },
		displayOptions: { show: { resource: ['letter'], operation: ['get'] } },
		description: 'The letter to get',
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: {
					searchListMethod: 'searchLetters',
					searchable: true,
				},
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. ltr_8Qm2xVb7KpL4',
			},
		],
	},

	/* -------------------------------------------------------------------------- */
	/*                                letter:getAll                               */
	/* -------------------------------------------------------------------------- */
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: { resource: ['letter'], operation: ['getAll'] } },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		displayOptions: { show: { resource: ['letter'], operation: ['getAll'], returnAll: [false] } },
		description: 'Max number of results to return',
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['letter'], operation: ['getAll'] } },
		options: [
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				default: 'posted',
				description:
					'Only letters with this status. Posted letters come newest posted first, the others newest created first.',
				options: [
					{ name: 'Cancelled', value: 'cancelled' },
					{ name: 'Draft', value: 'draft' },
					{ name: 'In Production', value: 'in_production' },
					{ name: 'Paid', value: 'paid' },
					{ name: 'Posted', value: 'posted' },
					{ name: 'Printed', value: 'printed' },
				],
			},
		],
	},
];
