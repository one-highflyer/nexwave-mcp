# NexWave MCP

NexWave MCP is a small, self-hosted gateway that lets users connect a NexWave or ERPNext site to an MCP client such as Claude or ChatGPT.

The gateway runs on Cloudflare Workers. It uses:

- Frappe's standard OAuth 2 authorization code flow for user sign-in
- Cloudflare's open-source OAuth Provider library for MCP client authorization
- D1 for the site registry and audit events
- KV for short-lived OAuth state, grants, and MCP tokens
- the current stateless MCP handler from the Cloudflare Agents SDK

It does not require a custom Frappe app. It does not use `frappe_assistant_core`.

## Live POC

- Setup page: `https://nexwave-mcp.hello-d72.workers.dev/admin`
- MCP endpoint: `https://nexwave-mcp.hello-d72.workers.dev/mcp`
- Connected test site: configured privately in the hosted setup page

The setup page needs the `ADMIN_TOKEN` Worker secret. A local recovery copy is in the ignored `.prod.vars` file for this POC. Move it to the team password manager before other people operate the service.

## Connect from Codex

Add the hosted MCP server and complete the browser sign-in:

```bash
codex mcp add nexwave --url https://nexwave-mcp.hello-d72.workers.dev/mcp
codex mcp login nexwave
```

Check the saved connection:

```bash
codex mcp get nexwave
```

Codex CLI and the Codex desktop app use the same MCP configuration.

## POC scope

The current tools are read-only:

- `get_current_user`
- `list_companies`
- `list_customers`
- `list_items`
- `list_sales_orders`
- `get_document` for an allowlist of common sales and purchase records

Frappe applies the signed-in user's normal permissions to every REST request.

## Local setup

Requirements:

- Node.js 20 or newer
- a Cloudflare account for deployment
- a Frappe v15 or NexWave site

Install dependencies and create local storage:

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

Open `http://localhost:8787/admin`.

Create an **OAuth Client** in Frappe with these settings:

| Field | Value |
| --- | --- |
| App Name | NexWave MCP |
| Scopes | `all openid` |
| Redirect URIs | `http://localhost:8787/oauth/frappe/callback` |
| Default Redirect URI | `http://localhost:8787/oauth/frappe/callback` |
| Grant Type | Authorization Code |
| Response Type | Code |
| Skip Authorization | Off |

Copy the generated client ID and secret into the NexWave MCP setup page. For a local Frappe bench, use a site URL such as `http://demo.localhost:8000`.

## Cloudflare deployment

Create one KV namespace and one D1 database, then replace the IDs in `wrangler.jsonc`.

The checked-in configuration currently identifies the HighFlyer POC resources. Replace the account and resource IDs before deploying a fork to another Cloudflare account.

Set two Worker secrets. Do not store these values in source control:

```sh
openssl rand -base64 32 | wrangler secret put ADMIN_TOKEN
openssl rand -base64 32 | wrangler secret put CONFIG_ENCRYPTION_KEY
```

Apply the database migration and deploy:

```sh
npm run db:remote
npm run deploy
```

For a hosted Worker at `https://nexwave-mcp.example.workers.dev`, set the Frappe OAuth redirect URI to:

```text
https://nexwave-mcp.example.workers.dev/oauth/frappe/callback
```

Then register the site at `/admin`. The MCP server URL is:

```text
https://nexwave-mcp.example.workers.dev/mcp
```

MCP clients can use OAuth discovery and dynamic client registration. The Worker asks the user for their NexWave site URL, matches its origin against the private site registry, sends the user to that site, and then returns control to the MCP client. It never shows users a list of registered sites.

## Security notes

- Site OAuth client secrets are encrypted with AES-256-GCM before D1 storage.
- Upstream tokens and the properties needed to refresh them are encrypted by the OAuth Provider library in KV.
- OAuth approval state expires after ten minutes and is bound to the same browser with an HTTP-only cookie.
- Frappe sign-in uses PKCE S256 as well as the confidential client secret.
- The admin API needs a separate bearer token.
- Site URLs must use HTTPS. HTTP is accepted only for local development hosts.
- The MCP tools do not accept arbitrary Frappe methods or URLs.
- The public consent page does not enumerate registered site names or URLs.

This POC stores an audit event for successful and failed sign-ins. It does not yet provide a full audit viewer, write tools, per-tool scope controls, or managed secret rotation.

## Checks

```sh
npm run check
npm test
wrangler deploy --dry-run
```
