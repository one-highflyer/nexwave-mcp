import { Hono } from "hono";
import type { Context, Next } from "hono";
import { createSite, deleteSite, listSites } from "./db";
import { encryptSecret, randomToken, safeBaseUrl } from "./security";
import type { Env } from "./types";

export const adminApp = new Hono<{ Bindings: Env }>();

adminApp.get("/admin", (context) => htmlResponse(ADMIN_HTML));

adminApp.get("/api/admin/sites", requireAdmin, async (context) => {
  const sites = await listSites(context.env);
  return context.json(
    sites.map((site) => ({
      id: site.id,
      displayName: site.display_name,
      baseUrl: site.base_url,
      clientId: site.client_id,
      enabled: Boolean(site.enabled),
      createdAt: site.created_at,
    })),
  );
});

adminApp.post("/api/admin/sites", requireAdmin, async (context) => {
  const input = await context.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const displayName = requiredString(input.displayName, "Display name", 100);
  const baseUrl = safeBaseUrl(requiredString(input.baseUrl, "Site URL", 300));
  const clientId = requiredString(input.clientId, "OAuth client ID", 200);
  const clientSecret = requiredString(input.clientSecret, "OAuth client secret", 500);
  const encryptedSecret = await encryptSecret(clientSecret, context.env.CONFIG_ENCRYPTION_KEY);
  const id = `site_${randomToken(12)}`;

  try {
    await createSite(context.env, {
      id,
      display_name: displayName,
      base_url: baseUrl,
      client_id: clientId,
      encrypted_client_secret: encryptedSecret,
      enabled: 1,
    });
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint/i.test(error.message)) {
      return context.json({ error: "That site URL is already registered." }, 409);
    }
    throw error;
  }

  return context.json({ id, displayName, baseUrl, clientId, enabled: true }, 201);
});

adminApp.delete("/api/admin/sites/:id", requireAdmin, async (context) => {
  const id = context.req.param("id");
  if (!id) return context.json({ error: "Site ID is required." }, 400);
  const deleted = await deleteSite(context.env, id);
  return deleted ? context.body(null, 204) : context.json({ error: "Site not found." }, 404);
});

async function requireAdmin(context: Context<{ Bindings: Env }>, next: Next) {
  const supplied = context.req.header("Authorization");
  if (!context.env.ADMIN_TOKEN || supplied !== `Bearer ${context.env.ADMIN_TOKEN}`) {
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

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172034; background: #f3f6fb; }
    body { margin: 0; }
    main { width: min(900px, calc(100% - 32px)); margin: 48px auto; }
    h1 { margin: 0 0 8px; font-size: clamp(28px, 5vw, 42px); letter-spacing: -0.04em; }
    .lead { color: #58647a; margin: 0 0 28px; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
    .card { background: white; border: 1px solid #dce3ef; border-radius: 16px; padding: 22px; box-shadow: 0 10px 30px rgba(28, 45, 78, .06); }
    h2 { margin-top: 0; font-size: 18px; }
    label { display: block; font-size: 13px; font-weight: 700; margin: 14px 0 6px; }
    input { box-sizing: border-box; width: 100%; padding: 11px 12px; border: 1px solid #bdc8d9; border-radius: 9px; font: inherit; }
    input:focus { outline: 3px solid #bde7de; border-color: #087a65; }
    button { margin-top: 16px; border: 0; border-radius: 9px; padding: 11px 16px; background: #087a65; color: white; font-weight: 750; cursor: pointer; }
    button.secondary { margin: 0; padding: 7px 10px; background: #eef2f7; color: #4d596e; }
    .site { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #e8edf4; }
    .site:last-child { border-bottom: 0; }
    .site strong, .site span { display: block; overflow-wrap: anywhere; }
    .site span { color: #69758a; font-size: 13px; margin-top: 3px; }
    .status { min-height: 20px; color: #9b321f; font-size: 14px; margin-top: 12px; }
    .hint { color: #69758a; font-size: 13px; line-height: 1.5; }
    code { background: #eef2f7; padding: 2px 5px; border-radius: 5px; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } main { margin-top: 28px; } }
  </style>
</head>
<body>
<main>
  <h1>NexWave MCP</h1>
  <p class="lead">Connect NexWave sites to Claude, ChatGPT, and other MCP clients.</p>
  <div class="grid">
    <section class="card">
      <h2>Add a site</h2>
      <p class="hint">Create an OAuth Client in NexWave. Set its redirect URI to <code id="callback"></code>, then copy its ID and secret here.</p>
      <form id="site-form">
        <label for="admin-token">MCP admin token</label>
        <input id="admin-token" type="password" autocomplete="current-password" required>
        <label for="display-name">Display name</label>
        <input id="display-name" placeholder="NexWave Demo" required maxlength="100">
        <label for="base-url">NexWave site URL</label>
        <input id="base-url" type="url" placeholder="https://example.nexwaveapp.com" required>
        <label for="client-id">OAuth client ID</label>
        <input id="client-id" required maxlength="200">
        <label for="client-secret">OAuth client secret</label>
        <input id="client-secret" type="password" autocomplete="new-password" required maxlength="500">
        <button type="submit">Save connection</button>
        <div class="status" id="status" role="status"></div>
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
      text.append(title, url);
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
  $('load').addEventListener('click', () => loadSites().catch((error) => $('status').textContent = error.message));
  $('site-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('status').textContent = '';
    sessionStorage.setItem('nexwave_mcp_admin_token', token());
    const body = {
      displayName: $('display-name').value,
      baseUrl: $('base-url').value,
      clientId: $('client-id').value,
      clientSecret: $('client-secret').value,
    };
    try {
      const response = await fetch('/api/admin/sites', { method: 'POST', headers: headers(), body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save the site.');
      $('client-secret').value = ''; $('status').textContent = 'Connection saved.'; await loadSites();
    } catch (error) { $('status').textContent = error.message; }
  });
</script>
</body>
</html>`;
