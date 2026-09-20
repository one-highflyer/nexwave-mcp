# NexWave MCP contributor guide

This repository contains a public, self-hosted MCP gateway for NexWave and ERPNext. It runs on Cloudflare Workers and connects to each registered Frappe site through that site's standard OAuth 2 flow.

## Project rules

- Keep MCP tools read-only unless a change explicitly introduces a reviewed write capability.
- Let Frappe enforce the signed-in user's normal roles and document permissions.
- Keep report names, DocTypes, fields, filters, methods, and outbound site origins allowlisted.
- Bound list sizes, report rows, and detailed report date ranges.
- Never expose a list of registered sites on a public page or in an MCP response.
- Never commit customer names, customer site URLs, credentials, OAuth codes, access tokens, refresh tokens, Worker secrets, or production data.
- Never log secrets or bearer tokens. Keep error messages useful without returning upstream response bodies that can contain private data.
- Accept plain HTTP only for local development hosts. Production site connections must use HTTPS.
- Preserve PKCE, OAuth state validation, short expiry times, and the browser-bound approval cookie.

## Trust boundaries

The MCP client authorises against this Worker. The Worker then authorises the user against the selected NexWave site. These are separate OAuth relationships.

- The Cloudflare OAuth Provider manages MCP client grants and tokens in KV.
- D1 stores the private site registry and audit events.
- Site OAuth client secrets are encrypted before they are written to D1.
- The registered site origin must exactly match the origin entered by the user.
- Frappe access tokens must be used only with their registered site.

Do not replace these checks with client-supplied URLs, arbitrary Frappe methods, or unrestricted report execution.

## Repository map

- `src/index.ts`: Worker routes and OAuth Provider entry point
- `src/auth.ts`: upstream Frappe OAuth flow
- `src/mcp.ts`: MCP server and read-only record tools
- `src/report-tools.ts`: allowlisted ERPNext report tools and output limits
- `src/frappe.ts`: Frappe REST and query report adapter
- `src/security.ts`: URL, state, and encryption helpers
- `src/db.ts`: D1 site registry and audit access
- `src/admin.ts` and `src/consent.ts`: setup and consent pages
- `migrations/`: ordered D1 migrations
- `test/`: Vitest tests
- `public/`: static brand assets

## Development workflow

Use Node.js 20 or newer and install dependencies with `npm ci` when a lockfile is present.

Run these checks before each pull request:

```sh
npm run check
npm test
npx wrangler deploy --dry-run
```

Add focused tests when changing authentication, URL validation, encryption, tool schemas, Frappe request construction, report filters, or output sanitisation.

Create a new numbered migration for a D1 schema change. Do not edit a migration that can already be applied in a deployed environment.

## GitHub and deployment

- Work on a branch and use a pull request. The protected `main` branch requires one approval and the `Validate` CI check.
- Use short, conventional-style commit messages.
- Keep public commit messages, pull requests, tests, and fixtures free of customer-specific information.
- CI validates the Worker but does not deploy it.
- Deploy production only after explicit authorisation, using `npm run deploy` from a verified commit.
- Do not commit `.dev.vars`, `.prod.vars`, Wrangler credentials, or local Cloudflare state.
