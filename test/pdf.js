'use strict';

/**
 * A small valid PDF for the tests: `pages` pages of `width` × `height` points (A4 by default) with one line of text at
 * (x, y). Text near an edge makes a PDF that fails the print check (no free margin).
 */
function makePdf({
	width = 595.28,
	height = 841.89,
	pages = 1,
	text = 'Test letter',
	x = 100,
	y = 700,
} = {}) {
	const objects = [];
	const add = (body) => objects.push(body);
	add(null); // 1: catalog
	add(null); // 2: page tree
	add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 3: font
	const kids = [];
	for (let i = 0; i < pages; i++) {
		const line = `${text} (page ${i + 1})`.replace(/[()\\]/g, (c) => `\\${c}`);
		const stream = `BT /F1 12 Tf ${x} ${y} Td (${line}) Tj ET`;
		const content = add(
			`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
		);
		kids.push(
			add(
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`,
			),
		);
	}
	objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
	objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

	let out = '%PDF-1.4\n';
	const offsets = objects.map((body, i) => {
		const offset = Buffer.byteLength(out, 'latin1');
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
		return offset;
	});
	const xref = Buffer.byteLength(out, 'latin1');
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, 'latin1');
}

/** An input item with the PDF in the binary field `property`, as n8n's Read/Write Files from Disk node gives it */
const pdfItem = (pdf, fileName = 'letter.pdf', property = 'data') => ({
	json: {},
	binary: {
		[property]: {
			data: pdf.toString('base64'),
			mimeType: 'application/pdf',
			fileName,
			fileSize: `${pdf.length} B`,
		},
	},
});

module.exports = { makePdf, pdfItem };
