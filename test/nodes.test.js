'use strict';

// The built nodes (npm run build) against the fake API of test/fake-api.js: nothing leaves the machine.
const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { startFakeApi } = require('./fake-api');
const { execute, listSearch, testCredential, trigger } = require('./harness');
const { makePdf, pdfItem } = require('./pdf');

/** The keys of every letter the nodes give, in the order of the Zapier app's letterOutput */
const LETTER_KEYS = [
	'id',
	'reference',
	'status',
	'recipient_name',
	'recipient_company',
	'recipient_address',
	'recipient_country',
	'pages',
	'printing',
	'double_sided',
	'registered',
	'total',
	'total_amount',
	'currency',
	'price_note',
	'tracking_number',
	'created_at',
	'paid_at',
	'posted_at',
	'url',
];

const RECIPIENT = {
	recipientName: 'Maria Schneider',
	recipientCompany: 'Schneider Immobilien GmbH',
	addressLine1: 'Hauptstraße 12',
	addressLine2: '',
	postalCode: '10115',
	city: 'Berlin',
	region: '',
	country: { __rl: true, mode: 'list', value: 'DE' },
};
const RECIPIENT_API = {
	name: 'Maria Schneider',
	company: 'Schneider Immobilien GmbH',
	line1: 'Hauptstraße 12',
	postalCode: '10115',
	city: 'Berlin',
	country: 'DE',
};
const PDF = makePdf();
const send = (extra = {}) => ({ resource: 'letter', operation: 'send', ...RECIPIENT, ...extra });
const write = (extra = {}) => ({
	resource: 'letter',
	operation: 'write',
	...RECIPIENT,
	subject: 'Your invoice 1042',
	text: '  Dear Ms Schneider,\n\nplease find our invoice attached.  ',
	...extra,
});

let api;
const calls = () => api.state.requests.map((r) => `${r.method} ${r.path}`);
const run = (args) => execute({ credentials: api.credentials, ...args });

before(async () => {
	api = await startFakeApi();
});
after(async () => {
	await api.close();
});
beforeEach(() => {
	Object.assign(api.state, {
		letters: [],
		documents: [],
		requests: [],
		queued: [],
		seq: 0,
		credit: true,
		senderDetails: true,
	});
});

describe('credential', () => {
	it('tests the key with GET /api/v1/account', async () => {
		const result = await testCredential(api.credentials);
		assert.equal(result.status, 'OK');
		assert.equal(result.body.email, 'owner@example.com');
		assert.deepEqual(calls(), ['GET /api/v1/account']);
		assert.equal(api.state.requests[0].apiKey, api.credentials.apiKey);
	});

	it("says a key that doesn't work was revoked, deleted or not copied in full", async () => {
		const result = await testCredential({ ...api.credentials, apiKey: 'pmc_wrong' });
		assert.equal(result.status, 'Error');
		assert.match(
			result.message,
			/^This API key doesn't work: it was revoked or deleted, or not copied in full\./,
		);
	});

	it('sends requests to production unless the hidden Base URL says otherwise', async () => {
		const { credentialType } = require('./harness');
		assert.equal(
			credentialType.properties.find((p) => p.name === 'baseUrl').default,
			'https://printandmailcompany.com',
		);
		assert.equal(credentialType.properties.find((p) => p.name === 'baseUrl').type, 'hidden');
	});
});

describe('Send', () => {
	it('uploads the PDF of the binary field and saves a draft (Send Now defaults to No)', async () => {
		const { output } = await run({
			parameters: send(),
			items: [pdfItem(PDF, 'Rechnung März.pdf')],
		});
		assert.deepEqual(calls(), ['POST /api/v1/documents', 'POST /api/v1/letters']);
		const [upload, create] = api.state.requests;
		assert.match(upload.contentType, /^multipart\/form-data; boundary=/);
		assert.equal(upload.multipart.length, 1);
		assert.equal(upload.multipart[0].name, 'file');
		assert.equal(upload.multipart[0].filename, 'Rechnung März.pdf');
		assert.equal(upload.multipart[0].contentType, 'application/pdf');
		assert.ok(upload.multipart[0].data.equals(PDF), 'the PDF arrives byte for byte');
		assert.deepEqual(create.body, {
			documentId: 'doc_1',
			recipient: RECIPIENT_API,
			color: 'bw',
			duplex: false,
			registered: false,
			paperSize: 'a4',
		});
		assert.equal(output.length, 1);
		assert.deepEqual(Object.keys(output[0].json), LETTER_KEYS);
		assert.equal(output[0].json.status, 'draft');
		assert.equal(output[0].json.printing, 'Black & white');
		assert.equal(output[0].json.total_amount, 2.45);
		assert.deepEqual(output[0].pairedItem, { item: 0 });
	});

	it('pays and releases the letter with Send Now: Yes, with the print options', async () => {
		const ok = await run({
			parameters: send({
				binaryPropertyName: 'pdf',
				sendNow: 'yes',
				color: 'color',
				doubleSided: true,
				registered: true,
				paperSize: 'us_letter',
			}),
			items: [pdfItem(PDF, 'letter.pdf', 'pdf')],
		});
		assert.deepEqual(calls(), [
			'POST /api/v1/documents',
			'POST /api/v1/letters',
			'POST /api/v1/letters/ltr_0002/send',
		]);
		assert.deepEqual(api.state.requests[1].body, {
			documentId: 'doc_1',
			recipient: RECIPIENT_API,
			color: 'color',
			duplex: true,
			registered: true,
			paperSize: 'us_letter',
		});
		assert.deepEqual(api.state.requests[2].body, { acceptTerms: true });
		assert.equal(ok.output[0].json.status, 'paid');
		assert.equal(ok.output[0].json.printing, 'Colour');
	});

	it('keeps a PDF that fails the print check as a draft and says where it is', async () => {
		const edge = makePdf({ x: 1, y: 420, text: 'AT THE EDGE' });
		await assert.rejects(
			run({ parameters: send({ sendNow: 'yes' }), items: [pdfItem(edge)] }),
			(error) => {
				assert.match(error.message, /^The PDF needs adjusting before it can be printed/);
				assert.match(
					error.message,
					/The letter PM-000002 was saved as a draft: open http:\/\/127\.0\.0\.1:\d+\/en\/app\/letters\/ltr_0002 to adjust the PDF, then send it\.$/,
				);
				return true;
			},
		);
		assert.deepEqual(calls(), ['POST /api/v1/documents', 'POST /api/v1/letters']);
	});

	it('refuses before any request: Send Now neither Yes nor No, no file, an empty file, a file over 4 MB', async () => {
		await assert.rejects(
			run({ parameters: send({ sendNow: 'maybe' }), items: [pdfItem(PDF)] }),
			/Choose 'Yes' or 'No' in 'Send Now'/,
		);
		await assert.rejects(
			run({ parameters: send(), items: [{ json: {} }] }),
			/binary file 'data', but none was found/,
		);
		await assert.rejects(
			run({ parameters: send(), items: [pdfItem(Buffer.alloc(0))] }),
			/The file in the binary field 'data' is empty/,
		);
		const big = Buffer.concat([PDF, Buffer.alloc(4 * 1024 * 1024)]);
		await assert.rejects(
			run({ parameters: send(), items: [pdfItem(big)] }),
			/^NodeOperationError: This PDF is 4\.0 MB\. Letters can be sent from PDFs of up to 4\.0 MB: save it as a smaller PDF/,
		);
		assert.deepEqual(calls(), []);
	});

	it('takes the country as a code, an English name or a common alias', async () => {
		const countryOf = async (value) => {
			api.state.requests = [];
			await run({
				parameters: send({ country: { __rl: true, mode: 'code', value } }),
				items: [pdfItem(PDF)],
			});
			return api.state.requests.find((r) => r.path === '/api/v1/letters').body.recipient.country;
		};
		assert.equal(await countryOf('de'), 'DE');
		assert.equal(calls().includes('GET /api/v1/destinations'), false);
		assert.equal(await countryOf(' Netherlands '), 'NL');
		assert.equal(calls()[0], 'GET /api/v1/destinations');
		assert.equal(await countryOf('UK'), 'GB');
		assert.equal(await countryOf('United States of America'), 'US');
		await assert.rejects(
			run({
				parameters: send({ country: { __rl: true, mode: 'code', value: 'Narnia' } }),
				items: [pdfItem(PDF)],
			}),
			/'Narnia' is not a country we recognise\. Choose it from the list in 'Country', or use its two-letter code, for example DE or US\./,
		);
		await assert.rejects(
			run({
				parameters: send({ country: { __rl: true, mode: 'list', value: '' } }),
				items: [pdfItem(PDF)],
			}),
			/Choose the country the letter goes to in 'Country'/,
		);
	});

	it('names the fields the API refuses, in the labels of the node', async () => {
		await assert.rejects(
			run({ parameters: send({ recipientName: 'X'.repeat(61) }), items: [pdfItem(PDF)] }),
			(error) => {
				assert.equal(
					error.message,
					'Some fields are missing or not valid: Recipient Name (too long).',
				);
				assert.equal(error.httpCode, '400');
				return true;
			},
		);
		await assert.rejects(
			run({ parameters: send({ postalCode: '' }), items: [pdfItem(PDF)] }),
			/^NodeApiError: The recipient's address is incomplete or not valid: Postcode or ZIP Code \(missing\)\.$/,
		);
	});
});

describe('Write', () => {
	it('composes the letter (no sender: the account sends it) and saves a draft', async () => {
		const { output } = await run({ parameters: write() });
		assert.deepEqual(calls(), ['POST /api/v1/compose']);
		assert.deepEqual(api.state.requests[0].body, {
			recipient: RECIPIENT_API,
			subject: 'Your invoice 1042',
			body: 'Dear Ms Schneider,\n\nplease find our invoice attached.',
			language: 'en',
			color: 'bw',
			duplex: false,
			registered: false,
		});
		assert.equal(output[0].json.status, 'draft');
		assert.deepEqual(Object.keys(output[0].json), LETTER_KEYS);
	});

	it('sends the closing, the name under it and the language when given, and pays with Send Now: Yes', async () => {
		const { output } = await run({
			parameters: write({
				language: 'de',
				closing: 'Mit freundlichen Grüßen',
				signature: 'Clara Hoffmann',
				sendNow: 'yes',
			}),
		});
		assert.deepEqual(calls(), ['POST /api/v1/compose', 'POST /api/v1/letters/ltr_0001/send']);
		assert.equal(api.state.requests[0].body.language, 'de');
		assert.equal(api.state.requests[0].body.closing, 'Mit freundlichen Grüßen');
		assert.equal(api.state.requests[0].body.signature, 'Clara Hoffmann');
		assert.equal(output[0].json.status, 'paid');
	});

	it('points to the account settings when the sender details are missing', async () => {
		api.state.senderDetails = false;
		await assert.rejects(run({ parameters: write() }), (error) => {
			assert.match(
				error.message,
				/^Your account needs your sender details first: your real full name and postal address, which every envelope shows as the sender\. Add them under Your details in your account settings \(http:\/\/127\.0\.0\.1:\d+\/en\/app\/settings\) and try again\.$/,
			);
			assert.equal(error.description, 'SENDER_DETAILS_REQUIRED: Sender details are required');
			return true;
		});
	});

	it('says where the draft is when it could not be paid', async () => {
		api.state.credit = false;
		await assert.rejects(run({ parameters: write({ sendNow: 'yes' }) }), (error) => {
			assert.match(
				error.message,
				/^There isn't enough credit in your account to pay for this letter\. Top up your credit at http:\/\/127\.0\.0\.1:\d+\/en\/app\/wallet and try again\. The letter PM-000001 was saved as a draft: http:\/\/127\.0\.0\.1:\d+\/en\/app\/letters\/ltr_0001$/,
			);
			assert.equal(error.httpCode, '402');
			return true;
		});
	});
});

describe('requests', () => {
	it("doesn't wait on a key the API refuses from the start", async () => {
		await assert.rejects(
			execute({ credentials: { ...api.credentials, apiKey: 'pmc_revoked' }, parameters: write() }),
			(error) => {
				assert.match(
					error.message,
					/^Print and Mail Company didn't accept the API key\. If it was revoked or deleted, create a new key under API & AI assistants in your account \(http:\/\/127\.0\.0\.1:\d+\/en\/app\/developers\)/,
				);
				assert.equal(error.httpCode, '401');
				return true;
			},
		);
		assert.deepEqual(calls(), ['POST /api/v1/compose']);
	});

	it('sends a request again when the server is busy with other PDFs (503) or asks to wait (429)', async () => {
		api.queue(
			'POST',
			/\/documents$/,
			503,
			{ error: { code: 'BUSY', message: 'Busy', details: { retryAfterSeconds: 1 } } },
			{ 'retry-after': '1' },
		);
		api.queue(
			'POST',
			/\/letters$/,
			429,
			{ error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
			{ 'retry-after': '1' },
		);
		const { output } = await run({ parameters: send(), items: [pdfItem(PDF)] });
		assert.deepEqual(calls(), [
			'POST /api/v1/documents',
			'POST /api/v1/documents',
			'POST /api/v1/letters',
			'POST /api/v1/letters',
		]);
		assert.equal(output[0].json.status, 'draft');
	});

	it('gives up after the retries with a message', async () => {
		for (let i = 0; i < 3; i++)
			api.queue('POST', /\/compose$/, 503, {
				error: { code: 'BUSY', message: 'Busy', details: { retryAfterSeconds: 1 } },
			});
		await assert.rejects(
			run({ parameters: write() }),
			/^NodeApiError: The server is busy with other PDFs\. Wait a moment and run the workflow again\.$/,
		);
		assert.equal(calls().length, 3);
	});

	it("doesn't wait on a 429 that names no short wait (the hourly limit)", async () => {
		api.queue('POST', /\/compose$/, 429, {
			error: { code: 'RATE_LIMITED', message: 'Too many requests' },
		});
		await assert.rejects(run({ parameters: write() }), (error) => {
			assert.equal(
				error.message,
				'There were too many requests in a short time. Wait a while and run the workflow again.',
			);
			assert.equal(error.httpCode, '429');
			return true;
		});
		assert.equal(calls().length, 1);
	});

	it('continues on fail with an error item for the item that failed', async () => {
		const { output } = await run({
			parameters: send(),
			items: [pdfItem(PDF), { json: {} }, pdfItem(PDF)],
			onError: 'continueRegularOutput',
		});
		assert.deepEqual(
			output.map((o) => o.json.status ?? 'error'),
			['draft', 'error', 'draft'],
		);
		assert.match(output[1].json.error, /binary file 'data', but none was found/);
		assert.deepEqual(
			output.map((o) => o.pairedItem.item),
			[0, 1, 2],
		);
	});
});

describe('Get and Get Many', () => {
	it('gets a letter by ID or from the list', async () => {
		const letter = api.addDraft();
		for (const mode of ['id', 'list']) {
			const { output } = await run({
				parameters: {
					resource: 'letter',
					operation: 'get',
					letterId: { __rl: true, mode, value: letter.id },
				},
			});
			assert.equal(output[0].json.reference, letter.reference);
		}
		await assert.rejects(
			run({
				parameters: {
					resource: 'letter',
					operation: 'get',
					letterId: { __rl: true, mode: 'id', value: 'ltr_nope' },
				},
			}),
			(error) => error.httpCode === '404' && error.message === 'Letter not found',
		);
		await assert.rejects(
			run({
				parameters: {
					resource: 'letter',
					operation: 'get',
					letterId: { __rl: true, mode: 'id', value: ' ' },
				},
			}),
			/Choose the letter in 'Letter', or enter its ID/,
		);
	});

	it('pages with offset for a limit over 100 and for Return All', async () => {
		for (let i = 0; i < 230; i++) api.addDraft();
		const limited = await run({
			parameters: { resource: 'letter', operation: 'getAll', limit: 150 },
		});
		assert.equal(limited.output.length, 150);
		assert.deepEqual(
			api.state.requests.map((r) => r.query),
			[{ limit: '100' }, { limit: '50', offset: '100' }],
		);
		assert.equal(new Set(limited.output.map((o) => o.json.id)).size, 150);

		api.state.requests = [];
		const all = await run({
			parameters: {
				resource: 'letter',
				operation: 'getAll',
				returnAll: true,
				filters: { status: 'draft' },
			},
		});
		assert.equal(all.output.length, 230);
		assert.deepEqual(
			api.state.requests.map((r) => r.query),
			[
				{ limit: '100', status: 'draft' },
				{ limit: '100', status: 'draft', offset: '100' },
				{ limit: '100', status: 'draft', offset: '200' },
			],
		);

		api.state.requests = [];
		const fifty = await run({ parameters: { resource: 'letter', operation: 'getAll' } });
		assert.equal(fifty.output.length, 50);
		assert.deepEqual(
			api.state.requests.map((r) => r.query),
			[{ limit: '50' }],
		);
	});

	it('stops after the first page on a server without offset (no loop, no duplicates)', async () => {
		const old = await startFakeApi({ paging: false });
		try {
			for (let i = 0; i < 150; i++) old.addDraft();
			const { output } = await execute({
				credentials: old.credentials,
				parameters: { resource: 'letter', operation: 'getAll', returnAll: true },
			});
			assert.equal(output.length, 100);
			assert.equal(old.state.requests.length, 2);
		} finally {
			await old.close();
		}
	});
});

describe('lists in the editor', () => {
	it('lists the countries by name and filters them', async () => {
		const { results } = await listSearch({
			method: 'searchCountries',
			filter: 'united',
			credentials: api.credentials,
		});
		assert.deepEqual(results, [
			{ name: 'United Kingdom', value: 'GB' },
			{ name: 'United States', value: 'US' },
		]);
		const byCode = await listSearch({
			method: 'searchCountries',
			filter: 'de',
			credentials: api.credentials,
		});
		assert.ok(byCode.results.some((r) => r.value === 'DE'));
	});

	it('lists the recent letters with reference, recipient and status', async () => {
		const letter = api.addDraft();
		api.addDraft();
		const { results } = await listSearch({
			method: 'searchLetters',
			filter: letter.reference.toLowerCase(),
			credentials: api.credentials,
		});
		assert.deepEqual(results, [
			{
				name: `${letter.reference} · ${letter.recipient.name} · Draft`,
				value: letter.id,
				url: letter.url,
			},
		]);
	});
});

describe('Trigger: Letter Posted', () => {
	it('shows the most recently posted letter in a manual test, and says when there is none', async () => {
		const t = trigger({ credentials: api.credentials });
		await assert.rejects(t.poll('manual'), /No letter has been posted from this account yet/);
		const [a, b] = [api.addDraft(), api.addDraft()];
		api.post([a, b]);
		const { result } = await t.poll('manual');
		assert.equal(result[0].length, 1);
		assert.equal(result[0][0].json.id, b.id);
		assert.deepEqual(Object.keys(result[0][0].json), LETTER_KEYS);
		assert.deepEqual(t.staticData, {}, 'a manual test leaves the remembered letters alone');
	});

	it('starts once per newly posted letter, oldest first, and never for letters posted before activation', async () => {
		const t = trigger({ credentials: api.credentials });
		const earlier = api.addDraft();
		api.post([earlier]);
		assert.equal((await t.poll()).result, null);
		assert.deepEqual(t.staticData.postedLetterIds, [earlier.id]);

		const [a, b, c] = [api.addDraft(), api.addDraft(), api.addDraft()];
		api.post([a, b]);
		const second = await t.poll();
		assert.deepEqual(
			second.result[0].map((i) => i.json.id),
			[a.id, b.id],
		);
		assert.ok(second.result[0].every((i) => i.json.status === 'posted'));
		assert.equal((await t.poll()).result, null);

		api.post([c]);
		assert.deepEqual(
			(await t.poll()).result[0].map((i) => i.json.id),
			[c.id],
		);
		assert.deepEqual(
			api.state.requests.map((r) => r.query),
			Array(4).fill({ status: 'posted', limit: '100' }),
		);
	});

	it('reads further pages when more than 100 letters were posted between two polls', async () => {
		const t = trigger({ credentials: api.credentials });
		assert.equal((await t.poll()).result, null);
		const batch = Array.from({ length: 150 }, () => api.addDraft());
		api.post(batch);
		api.state.requests = [];
		const { result } = await t.poll();
		assert.equal(result[0].length, 150);
		assert.deepEqual(
			result[0].map((i) => i.json.id),
			batch.map((l) => l.id),
		);
		assert.deepEqual(
			api.state.requests.map((r) => r.query),
			[
				{ status: 'posted', limit: '100' },
				{ status: 'posted', limit: '100', offset: '100' },
			],
		);
		assert.equal(t.staticData.postedLetterIds.length, 150);
	});
});
