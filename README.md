# n8n-nodes-printandmailcompany

Send real letters by post from your n8n workflows, with no printer and no stamps. [Print and Mail Company](https://printandmailcompany.com) prints your PDF, or a letter written from your text, puts it in an envelope and posts it to any country: in black and white or colour, single- or double-sided, and as registered mail with a tracking number if you like.

This package adds two nodes to n8n:

- **Print and Mail Company**: send a PDF as a letter, write a letter from text, and get your letters.
- **Print and Mail Company Trigger**: start a workflow when a letter has been posted.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/n8n-community-license/) workflow automation platform.

[Installation](#installation) ·
[Credentials](#credentials) ·
[Operations](#operations) ·
[Trigger](#trigger) ·
[Example workflow](#example-workflow) ·
[Compatibility](#compatibility) ·
[Resources](#resources) ·
[Development](#development) ·
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation. In short, on a self-hosted n8n: open **Settings → Community Nodes**, select **Install**, enter `n8n-nodes-printandmailcompany` and confirm.

## Credentials

The nodes connect to your Print and Mail Company account with an API key.

1. Create an account at [printandmailcompany.com](https://printandmailcompany.com) and confirm your email address (API keys can be created once it's confirmed).
2. In your account, open **API & AI assistants** ([direct link](https://printandmailcompany.com/en/app/developers)).
3. Under **API keys**, enter a name such as `n8n` and select **Create API key**.
4. Copy the key: it starts with `pmc_`, and you won't see it again.
5. In n8n, create a **Print and Mail Company API** credential, paste the key into **API Key** and save. n8n checks the key with your account straight away.

You can revoke a key under **API & AI assistants** at any time; workflows using it stop working until you enter a new one.

Two things in your account make sending smooth:

- **Your details** (in your account settings): your real full name and postal address, which every envelope shows as the sender. They're needed before your first letter.
- **Prepaid credit** (under **Credit & invoices**): letters sent with **Send Now: Yes** are paid from it. Drafts don't need any.

## Operations

All operations are on the **Letter** resource.

### Send

Prints and posts a PDF, or saves it as a draft to check first.

| Field | What it's for |
|---|---|
| PDF File | The name of the input binary field that holds the PDF (`data` by default), for example from **Read/Write Files from Disk** or **HTTP Request**. A4 or US Letter pages with a free margin on every side, up to 4 MB. |
| Recipient Name, Company or Organisation, Street Address, Additional Address Line, Postcode or ZIP Code, City or Town, State, Province or Region, Country | The recipient, as printed on the envelope. Choose the country from the list, or map a two-letter code (`DE`, `US`) or the country name in English. |
| Printing, Double-Sided, Registered Mail | Black & white or colour, one or both sides of the paper, and registered mail with a tracking number and a signature on delivery. The envelope is chosen for the number of pages. |
| Paper Size for US Letter PDFs | Only for a US Letter PDF sent outside the US, Canada and US territories: shrink it to A4 (recommended) or keep US Letter. |
| Send Now | **No** (the default) saves a draft that you check and send in your account. **Yes** accepts the [Terms & Conditions](https://printandmailcompany.com/en/legal/terms), asks for printing to start immediately, and pays the letter from your prepaid credit; the full wording you accept appears under the field when you choose it. |

A PDF that needs adjusting for print (content too close to the edge, or pages that are neither A4 nor US Letter) is never sent as it is: it stays a draft, and the node tells you where to open it.

### Write

Writes a letter from your text, lays it out and posts it, or saves it as a draft. It takes the same recipient, printing and **Send Now** fields as Send, plus:

| Field | What it's for |
|---|---|
| Subject | Printed above the text. |
| Letter Text | Start with the salutation, for example "Dear Sir or Madam,", and leave a blank line between paragraphs. The date, the closing and your name are added for you, and your sender details appear in the letter and on the envelope. |
| Language of the Letter | Sets the date format and the usual closing (Dutch, English, French, German, Italian, Portuguese or Spanish). |
| Closing, Name Under the Closing | Optional: your own closing (for example "Kind regards") and the name under it. |

### Get

Gets one letter: choose it from your recent letters, or enter its ID (for example from Send, Write or the trigger).

### Get Many

Gets your letters, newest first. Turn on **Return All** for every letter, or set a **Limit**. Under **Filters**, **Status** narrows the list to drafts, paid letters, letters in production, printed, posted or cancelled letters (posted letters come newest posted first).

### What the nodes give back

Every operation and the trigger give each letter with the same fields: `id`, `reference`, `status`, `recipient_name`, `recipient_company`, `recipient_address` (as printed on the envelope), `recipient_country`, `pages`, `printing`, `double_sided`, `registered`, `total`, `total_amount`, `currency`, `price_note`, `tracking_number` (registered letters, once posted), `created_at`, `paid_at`, `posted_at` and `url`, the letter's page in your account.

Large batches run through on their own: when the API asks for a moment, for example while it checks many PDFs at once or after very many requests in a row with one API key, the node waits (up to a minute) and goes on by itself.

## Trigger

**Print and Mail Company Trigger** starts the workflow when a letter has been posted (**Trigger On: Letter Posted**): one item per letter, in the order they were posted. It checks your account on the schedule you set under **Poll Times**.

When you activate the workflow, letters posted before that don't start it; every letter posted from then on does, once. **Fetch Test Event** shows your most recently posted letter, so you can map its fields.

## Example workflow

Send a PDF from a link as a letter. Import it with **Import from File**, or copy the JSON and paste it into the n8n editor. Then choose your credential, enter the link and the recipient. **Send Now** is set to **No**, so the letter waits as a draft in your account until you send it there.

```json
{
  "name": "Send a PDF from a link as a letter",
  "nodes": [
    {
      "parameters": {},
      "name": "When clicking 'Execute workflow'",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 0]
    },
    {
      "parameters": {
        "url": "https://example.com/invoice-1042.pdf",
        "options": { "response": { "response": { "responseFormat": "file" } } }
      },
      "name": "Download the PDF",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [220, 0]
    },
    {
      "parameters": {
        "resource": "letter",
        "operation": "send",
        "binaryPropertyName": "data",
        "recipientName": "Maria Schneider",
        "recipientCompany": "Schneider Immobilien GmbH",
        "addressLine1": "Hauptstraße 12",
        "postalCode": "10115",
        "city": "Berlin",
        "country": { "__rl": true, "mode": "list", "value": "DE", "cachedResultName": "Germany" },
        "registered": true,
        "sendNow": "no"
      },
      "name": "Print and Mail Company",
      "type": "n8n-nodes-printandmailcompany.printAndMailCompany",
      "typeVersion": 1,
      "position": [440, 0]
    }
  ],
  "connections": {
    "When clicking 'Execute workflow'": { "main": [[{ "node": "Download the PDF", "type": "main", "index": 0 }]] },
    "Download the PDF": { "main": [[{ "node": "Print and Mail Company", "type": "main", "index": 0 }]] }
  }
}
```

More ideas:

- **Invoices by post:** when your accounting tool creates an invoice PDF, send it with Send and map the customer's address from the same item.
- **Letters from a sheet:** read rows from a spreadsheet and write one letter per row with Write, mapping the recipient and the text from the columns.
- **Tell your team:** start a workflow with the trigger and post the `tracking_number` of each registered letter to your chat or CRM.

## Compatibility

Built with `@n8n/node-cli` 0.57 against `n8n-workflow` 2.48 (n8n 2.x). The package has no runtime dependencies.

## Resources

- [Print and Mail Company](https://printandmailcompany.com)
- [Print and Mail Company REST API (OpenAPI)](https://printandmailcompany.com/openapi.json)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## Development

```bash
npm ci
npm run build   # compiles to dist/
npm run lint    # n8n's linter (n8n-node lint)
npm test        # the built nodes against a local stand-in for the API (test/), no network
npm run dev     # n8n with these nodes at http://localhost:5678 (downloads n8n)
```

The credential has a hidden **Base URL** field that is always `https://printandmailcompany.com` in the n8n editor. It exists so the nodes can be tried against a local copy of the API while they are developed; a credential with another value can only be created outside the editor.

### Release checklist

1. Make sure `main` is green: `npm run lint`, `npm run build` and `npm test` pass.
2. Run `npm run release` on `main`. It lints, builds, asks for the new version, updates `CHANGELOG.md`, commits, tags and pushes.
3. The tag starts `.github/workflows/publish.yml`, which publishes the package to npm with a provenance statement (npm Trusted Publishing, or an `NPM_TOKEN` repository secret).
4. Scan the published version with n8n's scanner. It must pass before you submit or update the node in the [n8n Creator Portal](https://creators.n8n.io/nodes):

   ```bash
   npx @n8n/scan-community-package n8n-nodes-printandmailcompany
   ```

## Version history

See [CHANGELOG.md](CHANGELOG.md).

- **0.1.0**: first version: Send, Write, Get and Get Many letters, and the Letter Posted trigger.

## License

[MIT](LICENSE.md)
