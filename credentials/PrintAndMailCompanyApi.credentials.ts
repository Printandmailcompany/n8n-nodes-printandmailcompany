import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class PrintAndMailCompanyApi implements ICredentialType {
	name = 'printAndMailCompanyApi';

	displayName = 'Print and Mail Company API';

	icon: Icon = {
		light: 'file:../nodes/PrintAndMailCompany/printAndMailCompany.svg',
		dark: 'file:../nodes/PrintAndMailCompany/printAndMailCompany.dark.svg',
	};

	documentationUrl =
		'https://github.com/Printandmailcompany/n8n-nodes-printandmailcompany#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Create an API key in your account under <a href="https://printandmailcompany.com/en/app/developers">API & AI assistants</a> and paste it here. It starts with <code>pmc_</code>.',
		},
		{
			// Where the API is. Hidden: always https://printandmailcompany.com, except for a credential created with
			// another value outside the editor, e.g. to try the nodes against a local server while developing them
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'hidden',
			default: 'https://printandmailcompany.com',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'x-api-key': '={{$credentials.apiKey}}',
			},
		},
	};

	/** The account the key belongs to (GET /api/v1/account), as the Zapier app tests its connection */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}/api/v1',
			url: '/account',
			method: 'GET',
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message:
						"This API key doesn't work: it was revoked or deleted, or not copied in full. Create a new key under API & AI assistants in your account (https://printandmailcompany.com/en/app/developers) and paste it here.",
				},
			},
		],
	};
}
