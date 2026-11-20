'use strict';

/**
 * A small stand-in for the Print and Mail Company REST API (/api/v1) on a local port, for the tests: the endpoints the
 * nodes use, their answers in the API's shapes, and queued answers for refusals. No request leaves the machine.
 */

const http = require('node:http');

const KEY = 'pmc_test_0123456789';

const DESTINATIONS = [
	{ code: 'DE', name: 'Germany', zone: 'Z1' },
	{ code: 'FR', name: 'France', zone: 'Z1' },
	{ code: 'NL', name: 'Netherlands', zone: 'Z1' },
	{ code: 'GB', name: 'United Kingdom', zone: 'Z2' },
	{ code: 'US', name: 'United States', zone: 'Z4' },
];

const send = (res, status, body, headers = {}) => {
	res.writeHead(status, { 'content-type': 'application/json', ...headers });
	res.end(JSON.stringify(body));
};
const refuse = (res, status, code, message, details) =>
	send(res, status, { error: { code, message, ...(details ? { details } : {}) } });

/** The parts of a multipart/form-data body: name, filename, content type and bytes */
function parseMultipart(contentType, body) {
	const boundary = /boundary=(.+)$/.exec(contentType ?? '')?.[1];
	if (!boundary) return null;
	const parts = [];
	const delimiter = Buffer.from(`--${boundary}`);
	let start = body.indexOf(delimiter);
	while (start !== -1) {
		const next = body.indexOf(delimiter, start + delimiter.length);
		if (next === -1) break;
		const part = body.subarray(start + delimiter.length + 2, next - 2);
		const split = part.indexOf('\r\n\r\n');
		const head = part.subarray(0, split).toString('utf8');
		parts.push({
			name: /name="([^"]*)"/.exec(head)?.[1],
			filename: /filename="([^"]*)"/.exec(head)?.[1],
			contentType: /Content-Type: (.+)/i.exec(head)?.[1]?.trim(),
			data: part.subarray(split + 4),
		});
		start = next;
	}
	return parts;
}

function startFakeApi({ paging = true } = {}) {
	const state = {
		letters: [],
		documents: [],
		requests: [],
		queued: [],
		seq: 0,
		credit: true,
		senderDetails: true,
	};
	const letterUrl = (base, id) => `${base}/en/app/letters/${id}`;

	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const url = new URL(req.url, 'http://localhost');
			const raw = Buffer.concat(chunks);
			const isJson = /application\/json/.test(req.headers['content-type'] ?? '');
			const record = {
				method: req.method,
				path: url.pathname,
				query: Object.fromEntries(url.searchParams),
				apiKey: req.headers['x-api-key'],
				contentType: req.headers['content-type'],
				body: isJson && raw.length ? JSON.parse(raw.toString('utf8')) : undefined,
				multipart: /multipart\/form-data/.test(req.headers['content-type'] ?? '')
					? parseMultipart(req.headers['content-type'], raw)
					: undefined,
			};
			state.requests.push(record);
			const base = `http://127.0.0.1:${server.address().port}`;

			const queued = state.queued.findIndex(
				(q) => q.method === req.method && q.path.test(url.pathname),
			);
			if (queued !== -1) {
				const [answer] = state.queued.splice(queued, 1);
				return send(res, answer.status, answer.body, answer.headers);
			}

			const path = url.pathname.replace(/^\/api\/v1/, '');
			if (req.method === 'GET' && path === '/destinations')
				return send(res, 200, { destinations: DESTINATIONS });
			if (req.headers['x-api-key'] !== KEY)
				return refuse(res, 401, 'UNAUTHORIZED', 'Invalid API key');

			if (req.method === 'GET' && path === '/account') {
				return send(res, 200, {
					email: 'owner@example.com',
					name: 'Clara Hoffmann',
					currency: 'EUR',
				});
			}
			if (req.method === 'GET' && path === '/letters') {
				const status = url.searchParams.get('status');
				const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20));
				const offset = paging ? Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0) : 0;
				const key = status === 'posted' ? 'postedAt' : 'createdAt';
				const letters = state.letters
					.filter((l) => !status || l.status === status)
					.sort((a, b) => String(b[key]).localeCompare(String(a[key])) || b.seq - a.seq)
					.slice(offset, offset + limit);
				return send(res, 200, { letters });
			}
			const letterMatch = /^\/letters\/([^/]+)(\/send)?$/.exec(path);
			if (req.method === 'GET' && letterMatch && !letterMatch[2]) {
				const letter = state.letters.find((l) => l.id === decodeURIComponent(letterMatch[1]));
				return letter ? send(res, 200, letter) : refuse(res, 404, 'NOT_FOUND', 'Letter not found');
			}
			if (req.method === 'POST' && path === '/documents') {
				const file = record.multipart?.find((p) => p.name === 'file');
				if (!file)
					return refuse(res, 400, 'INVALID_REQUEST', 'The request is invalid', [
						{ path: 'file', message: 'Missing file' },
					]);
				if (!file.data.subarray(0, 5).equals(Buffer.from('%PDF-')))
					return refuse(res, 422, 'NOT_PDF', 'The file is not a PDF');
				const doc = {
					id: `doc_${++state.seq}`,
					fileName: file.filename,
					sizeBytes: file.data.length,
					// The test PDFs with text at the edge of the page fail the print check
					compliant: !file.data.includes('AT THE EDGE'),
				};
				state.documents.push(doc);
				return send(res, 201, doc);
			}
			const draftFrom = (recipient, options) => {
				const seq = ++state.seq;
				const letter = {
					id: `ltr_${String(seq).padStart(4, '0')}`,
					seq,
					reference: `PM-${String(seq).padStart(6, '0')}`,
					status: 'draft',
					recipient,
					recipientLines: [
						recipient.name,
						recipient.company,
						recipient.line1,
						`${recipient.postalCode ?? ''} ${String(recipient.city).toUpperCase()}`.trim(),
						recipient.country,
					].filter(Boolean),
					options: {
						pages: 1,
						duplex: Boolean(options.duplex),
						color: options.color ?? 'bw',
						registered: Boolean(options.registered),
					},
					currency: 'EUR',
					total: 245,
					totalFormatted: '€2.45',
					priceLabel: 'incl. 17% VAT',
					trackingNumber: null,
					createdAt: new Date(Date.UTC(2026, 10, 20, 9, 0, seq)).toISOString(),
					paidAt: null,
					postedAt: null,
					url: letterUrl(base, `ltr_${String(seq).padStart(4, '0')}`),
				};
				state.letters.push(letter);
				return letter;
			};
			if (req.method === 'POST' && path === '/letters') {
				const { documentId, recipient = {}, ...options } = record.body ?? {};
				if (!state.documents.some((d) => d.id === documentId))
					return refuse(res, 404, 'NOT_FOUND', 'Document not found');
				if (String(recipient.name ?? '').length > 60) {
					return refuse(res, 400, 'INVALID_REQUEST', 'The request is invalid', [
						{ path: 'recipient.name', message: 'Too big: expected string to have <=60 characters' },
					]);
				}
				if (!recipient.postalCode && recipient.country === 'DE') {
					return refuse(res, 422, 'INVALID_ADDRESS', "The recipient's address is incomplete", {
						fields: { postalCode: 'required' },
					});
				}
				return send(res, 201, { ...draftFrom(recipient, options), senderDetails: 'on_file' });
			}
			if (req.method === 'POST' && path === '/compose') {
				if (!state.senderDetails)
					return refuse(res, 422, 'SENDER_DETAILS_REQUIRED', 'Sender details are required');
				const { recipient, ...rest } = record.body ?? {};
				const letter = draftFrom(recipient, rest);
				return send(res, 201, {
					document: { id: `doc_${letter.seq}`, compliant: true },
					letter,
					senderDetails: 'on_file',
				});
			}
			if (req.method === 'POST' && letterMatch?.[2]) {
				const letter = state.letters.find((l) => l.id === decodeURIComponent(letterMatch[1]));
				if (!letter) return refuse(res, 404, 'NOT_FOUND', 'Letter not found');
				if (record.body?.acceptTerms !== true)
					return refuse(res, 400, 'INVALID_REQUEST', 'The request is invalid', [
						{ path: 'acceptTerms', message: 'Invalid input' },
					]);
				if (!state.credit)
					return refuse(res, 402, 'INSUFFICIENT_FUNDS', 'Not enough credit', { shortfall: 245 });
				Object.assign(letter, {
					status: 'paid',
					paidAt: new Date(Date.UTC(2026, 10, 20, 10, 0, letter.seq)).toISOString(),
				});
				return send(res, 200, letter);
			}
			return refuse(res, 404, 'NOT_FOUND', 'Unknown endpoint');
		});
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const baseUrl = `http://127.0.0.1:${server.address().port}`;
			resolve({
				baseUrl,
				credentials: { apiKey: KEY, baseUrl },
				state,
				/** The next request matching method and path gets this answer instead */
				queue: (method, path, status, body, headers) =>
					state.queued.push({ method, path, status, body, headers }),
				/** Letters posted at the given times (oldest first), as the production team marks them */
				post: (letters) => {
					for (const letter of letters) {
						Object.assign(letter, {
							status: 'posted',
							postedAt: new Date(
								Date.UTC(2026, 10, 21, 8, 0, 0) + ++state.seq * 1000,
							).toISOString(),
						});
					}
				},
				/** A draft letter straight in the store, as if created earlier */
				addDraft: () => {
					const seq = ++state.seq;
					const letter = {
						id: `ltr_${String(seq).padStart(4, '0')}`,
						seq,
						reference: `PM-${String(seq).padStart(6, '0')}`,
						status: 'draft',
						recipient: {
							name: `Recipient ${seq}`,
							line1: 'Hauptstraße 12',
							postalCode: '10115',
							city: 'Berlin',
							country: 'DE',
						},
						recipientLines: [`Recipient ${seq}`, 'Hauptstraße 12', '10115 BERLIN', 'GERMANY'],
						options: { pages: 1, duplex: false, color: 'bw', registered: false },
						currency: 'EUR',
						total: 245,
						totalFormatted: '€2.45',
						priceLabel: 'incl. 17% VAT',
						trackingNumber: null,
						createdAt: new Date(Date.UTC(2026, 10, 1, 9, 0, 0) + seq * 1000).toISOString(),
						paidAt: null,
						postedAt: null,
						url: `${baseUrl}/en/app/letters/ltr_${String(seq).padStart(4, '0')}`,
					};
					state.letters.push(letter);
					return letter;
				},
				close: () => new Promise((r) => server.close(r)),
			});
		});
	});
}

module.exports = { startFakeApi, KEY };
