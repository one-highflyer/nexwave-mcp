import { Hono } from "hono";
import type { Context, Next } from "hono";
import { BRAND_HEAD, BRAND_MARK } from "./brand";
import { createSite, deleteSite, getSiteByBaseUrl, listSites } from "./db";
import { getApiTokenUser } from "./frappe";
import { encryptSecret, randomToken, safeBaseUrl, secureEqual, sha256 } from "./security";
import type { Env, SiteAuthType, SiteRecord } from "./types";

export const adminApp = new Hono<{ Bindings: Env }>();

adminApp.get("/admin", (context) => htmlResponse(ADMIN_HTML));

adminApp.get("/api/admin/sites", requireAdmin, async (context) => {
  const sites = await listSites(context.env);
  return context.json(
    sites.map((site) => ({
      id: site.id,
      displayName: site.display_name,
      baseUrl: site.base_url,
      authType: site.auth_type,
      clientId: site.client_id,
      apiUser: site.api_user,
      enabled: Boolean(site.enabled),
      createdAt: site.created_at,
    })),
  );
});

adminApp.post("/api/admin/sites", requireAdmin, async (context) => {
  const input = await context.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const displayName = requiredString(input.displayName, "Display name", 100);
  const baseUrl = safeBaseUrl(requiredString(input.baseUrl, "Site URL", 300));
  const authType = requiredAuthType(input.authType);
  if (await getSiteByBaseUrl(context.env, baseUrl, authType)) {
    return context.json({ error: "That site URL and authentication type are already registered." }, 409);
  }

  const id = `site_${randomToken(12)}`;
  let serviceToken: string | undefined;
  let site: Omit<SiteRecord, "created_at" | "updated_at">;

  if (authType === "oauth") {
    const clientId = requiredString(input.clientId, "OAuth client ID", 200);
    const clientSecret = requiredString(input.clientSecret, "OAuth client secret", 500);
    site = {
      id,
      display_name: displayName,
      base_url: baseUrl,
      auth_type: authType,
      client_id: clientId,
      encrypted_client_secret: await encryptSecret(clientSecret, context.env.CONFIG_ENCRYPTION_KEY),
      encrypted_api_key: null,
      encrypted_api_secret: null,
      api_user: null,
      service_token_hash: null,
      enabled: 1,
    };
  } else {
    const apiKey = requiredString(input.apiKey, "API key", 500);
    const apiSecret = requiredString(input.apiSecret, "API secret", 500);
    let apiUser: string;
    try {
      apiUser = await getApiTokenUser(baseUrl, apiKey, apiSecret);
    } catch {
      return context.json({ error: "The fixed API token could not authenticate to this NexWave site." }, 400);
    }

    serviceToken = `nwmcp_${randomToken(32)}`;
    const [encryptedApiKey, encryptedApiSecret, serviceTokenHash] = await Promise.all([
      encryptSecret(apiKey, context.env.CONFIG_ENCRYPTION_KEY),
      encryptSecret(apiSecret, context.env.CONFIG_ENCRYPTION_KEY),
      sha256(serviceToken),
    ]);
    site = {
      id,
      display_name: displayName,
      base_url: baseUrl,
      auth_type: authType,
      client_id: null,
      encrypted_client_secret: null,
      encrypted_api_key: encryptedApiKey,
      encrypted_api_secret: encryptedApiSecret,
      api_user: apiUser,
      service_token_hash: serviceTokenHash,
      enabled: 1,
    };
  }

  try {
    await createSite(context.env, site);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint/i.test(error.message)) {
      return context.json({ error: "That site URL is already registered." }, 409);
    }
    throw error;
  }

  if (serviceToken) context.header("Cache-Control", "no-store");
  return context.json({
    id,
    displayName,
    baseUrl,
    authType,
    apiUser: site.api_user,
    serviceToken,
    enabled: true,
  }, 201);
});

adminApp.delete("/api/admin/sites/:id", requireAdmin, async (context) => {
  const id = context.req.param("id");
  if (!id) return context.json({ error: "Site ID is required." }, 400);
  const deleted = await deleteSite(context.env, id);
  return deleted ? context.body(null, 204) : context.json({ error: "Site not found." }, 404);
});

async function requireAdmin(context: Context<{ Bindings: Env }>, next: Next) {
  const supplied = context.req.header("Authorization");
  if (
    !context.env.ADMIN_TOKEN
    || !supplied
    || !(await secureEqual(supplied, `Bearer ${context.env.ADMIN_TOKEN}`))
  ) {
    return context.json({ error: "A valid admin token is required." }, 401);
  }
  await next();
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const result = value.trim();
  if (result.length > maxLength) throw new Error(`${label} is too long.`);
  return result;
}

function requiredAuthType(value: unknown): SiteAuthType {
  if (value === "oauth" || value === "api_token") return value;
  throw new Error("Authentication type must be OAuth or fixed API token.");
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexWave MCP setup</title>
  ${BRAND_HEAD}
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #111739; background: #f8f8fc; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 12% 0%, rgba(0, 222, 234, .12), transparent 32%), radial-gradient(circle at 88% 2%, rgba(229, 23, 216, .1), transparent 30%), #f8f8fc; }
    main { width: min(960px, calc(100% - 32px)); margin: 42px auto 64px; }
    .brand-lockup { display: flex; width: fit-content; align-items: center; gap: 11px; margin-bottom: 34px; }
    .brand-logo { width: 48px; height: 48px; }
    .brand-name strong, .brand-name span { display: block; }
    .brand-name strong { color: #111739; font-size: 19px; letter-spacing: -.02em; }
    .brand-name span { margin-top: 2px; color: #686d8a; font-size: 11px; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
    .eyebrow { display: inline-block; margin-bottom: 9px; color: #6536e8; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0 0 9px; font-size: clamp(30px, 5vw, 44px); letter-spacing: -.045em; line-height: 1.05; }
    .lead { color: #5e6380; margin: 0 0 30px; line-height: 1.55; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
    .card { position: relative; overflow: hidden; background: rgba(255, 255, 255, .94); border: 1px solid #e4e2ef; border-radius: 18px; padding: 24px; box-shadow: 0 16px 44px rgba(25, 19, 71, .07); }
    .card::before { position: absolute; inset: 0 0 auto; height: 3px; background: linear-gradient(90deg, #00dfea, #6338e7 55%, #e517d8); content: ""; }
    h2 { margin: 0 0 6px; font-size: 19px; letter-spacing: -.02em; }
    label { display: block; font-size: 13px; font-weight: 700; margin: 14px 0 6px; }
    input, select { box-sizing: border-box; width: 100%; padding: 11px 12px; border: 1px solid #c8c8d9; border-radius: 10px; background: #fff; color: #111739; font: inherit; transition: border-color .15s, box-shadow .15s; }
    input:focus, select:focus { outline: 0; border-color: #6536e8; box-shadow: 0 0 0 3px rgba(101, 54, 232, .14); }
    button { margin-top: 16px; border: 0; border-radius: 10px; padding: 11px 16px; background: linear-gradient(115deg, #513bd7, #a923d3); color: white; font-weight: 750; cursor: pointer; box-shadow: 0 7px 18px rgba(92, 48, 207, .2); }
    button:hover { filter: brightness(.97); }
    button:focus-visible { outline: 3px solid rgba(0, 213, 229, .45); outline-offset: 2px; }
    button.secondary { margin: 0; padding: 7px 10px; background: #f0eff8; color: #4c4768; box-shadow: none; }
    .site { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding: 13px 0; border-bottom: 1px solid #eceaf4; }
    .site:last-child { border-bottom: 0; }
    .site strong, .site span { display: block; overflow-wrap: anywhere; }
    .site span { color: #6a6e87; font-size: 13px; margin-top: 3px; }
    .status { min-height: 20px; color: #5d3474; font-size: 14px; margin-top: 12px; }
    .hint { color: #6a6e87; font-size: 13px; line-height: 1.5; }
    .hidden { display: none; }
    .service-token { margin-top: 16px; padding: 14px; border: 1px solid #cfc9ee; border-radius: 10px; background: #f5f2ff; }
    .service-token p { margin: 0 0 8px; }
    code { background: #f0eff8; padding: 2px 5px; border-radius: 5px; color: #493f85; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } main { margin-top: 24px; } .brand-lockup { margin-bottom: 28px; } }
    @media (prefers-reduced-motion: reduce) { input { transition: none; } }
  </style>
</head>
<body>
<main>
  ${BRAND_MARK}
  <span class="eyebrow">Secure connections</span>
  <h1>MCP setup</h1>
  <p class="lead">Connect NexWave sites to Claude, ChatGPT, and other MCP clients.</p>
  <div class="grid">
    <section class="card">
      <h2>Add a site</h2>
      <p class="hint">Choose interactive OAuth for user connections, or a fixed API token for service clients such as voice agents.</p>
      <form id="site-form">
        <label for="admin-token">MCP admin token</label>
        <input id="admin-token" type="password" autocomplete="current-password" required>
        <label for="display-name">Display name</label>
        <input id="display-name" placeholder="NexWave Demo" required maxlength="100">
        <label for="base-url">NexWave site URL</label>
        <input id="base-url" type="url" placeholder="https://example.nexwaveapp.com" required>
        <label for="auth-type">Authentication</label>
        <select id="auth-type">
          <option value="oauth">OAuth 2</option>
          <option value="api_token">Fixed API token</option>
        </select>
        <div id="oauth-fields">
          <p class="hint">Set the NexWave OAuth Client redirect URI to <code id="callback"></code>.</p>
          <label for="client-id">OAuth client ID</label>
          <input id="client-id" maxlength="200">
          <label for="client-secret">OAuth client secret</label>
          <input id="client-secret" type="password" autocomplete="new-password" maxlength="500">
        </div>
        <div id="api-token-fields" class="hidden">
          <p class="hint">Use credentials from a dedicated NexWave user. The gateway verifies them before saving the connection.</p>
          <label for="api-key">API key</label>
          <input id="api-key" type="password" autocomplete="new-password" maxlength="500">
          <label for="api-secret">API secret</label>
          <input id="api-secret" type="password" autocomplete="new-password" maxlength="500">
        </div>
        <button type="submit">Save connection</button>
        <div class="status" id="status" role="status"></div>
        <div class="service-token hidden" id="service-token-panel">
          <p><strong>Copy this service token now.</strong> It is not shown again.</p>
          <input id="service-token" readonly>
          <button class="secondary" id="copy-service-token" type="button">Copy token</button>
        </div>
      </form>
    </section>
    <section class="card">
      <h2>Registered sites</h2>
      <p class="hint">Enter the admin token to load and manage connections.</p>
      <button id="load" type="button">Load sites</button>
      <div id="sites"></div>
    </section>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  $('callback').textContent = location.origin + '/oauth/frappe/callback';
  $('admin-token').value = sessionStorage.getItem('nexwave_mcp_admin_token') || '';
  const token = () => $('admin-token').value;
  const headers = () => ({ Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' });
  function syncAuthFields() {
    const oauth = $('auth-type').value === 'oauth';
    $('oauth-fields').classList.toggle('hidden', !oauth);
    $('api-token-fields').classList.toggle('hidden', oauth);
    $('client-id').required = oauth; $('client-secret').required = oauth;
    $('api-key').required = !oauth; $('api-secret').required = !oauth;
  }
  async function loadSites() {
    sessionStorage.setItem('nexwave_mcp_admin_token', token());
    const response = await fetch('/api/admin/sites', { headers: headers() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load sites.');
    const list = $('sites'); list.replaceChildren();
    if (!data.length) { list.textContent = 'No sites are registered.'; return; }
    for (const site of data) {
      const row = document.createElement('div'); row.className = 'site';
      const text = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = site.displayName;
      const url = document.createElement('span'); url.textContent = site.baseUrl;
      const authentication = document.createElement('span');
      authentication.textContent = site.authType === 'api_token'
        ? 'Fixed API token' + (site.apiUser ? ' · ' + site.apiUser : '')
        : 'OAuth 2';
      text.append(title, url, authentication);
      const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        if (!confirm('Remove ' + site.displayName + '?')) return;
        const response = await fetch('/api/admin/sites/' + encodeURIComponent(site.id), { method: 'DELETE', headers: headers() });
        if (!response.ok) throw new Error('Could not remove the site.');
        await loadSites();
      });
      row.append(text, remove); list.append(row);
    }
  }
  $('auth-type').addEventListener('change', syncAuthFields);
  syncAuthFields();
  $('copy-service-token').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('service-token').value);
    $('copy-service-token').textContent = 'Copied';
  });
  $('load').addEventListener('click', () => loadSites().catch((error) => $('status').textContent = error.message));
  $('site-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('status').textContent = '';
    $('service-token-panel').classList.add('hidden'); $('service-token').value = '';
    sessionStorage.setItem('nexwave_mcp_admin_token', token());
    const body = {
      displayName: $('display-name').value,
      baseUrl: $('base-url').value,
      authType: $('auth-type').value,
      clientId: $('client-id').value,
      clientSecret: $('client-secret').value,
      apiKey: $('api-key').value,
      apiSecret: $('api-secret').value,
    };
    try {
      const response = await fetch('/api/admin/sites', { method: 'POST', headers: headers(), body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save the site.');
      $('client-secret').value = ''; $('api-key').value = ''; $('api-secret').value = '';
      $('status').textContent = 'Connection saved.';
      if (data.serviceToken) {
        $('service-token').value = data.serviceToken;
        $('service-token-panel').classList.remove('hidden');
        $('copy-service-token').textContent = 'Copy token';
      }
      await loadSites();
    } catch (error) { $('status').textContent = error.message; }
  });
</script>
</body>
</html>`;
