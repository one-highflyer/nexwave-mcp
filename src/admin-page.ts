import { BRAND_HEAD, BRAND_MARK } from "./brand";

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexWave MCP setup</title>
  ${BRAND_HEAD}
  <link rel="stylesheet" href="/admin.css">
  <script src="/admin.js" defer></script>
</head>
<body>
<main>
  <header class="page-header">
    ${BRAND_MARK}
    <h1>MCP connections</h1>
    <p>Manage the NexWave sites and actions available to your AI clients.</p>
  </header>

  <section class="access-panel" aria-labelledby="access-heading">
    <div class="access-intro">
      <h2 id="access-heading">Administrator access</h2>
      <p>Use your MCP admin token to load and manage connections.</p>
    </div>
    <form id="access-form">
      <div class="token-field">
        <label for="admin-token">MCP admin token</label>
        <input id="admin-token" type="password" autocomplete="current-password" required placeholder="Enter your admin token">
      </div>
      <button id="load" type="submit">Load connections</button>
    </form>
    <p id="access-status" class="notice" role="status" aria-live="polite" hidden></p>
  </section>

  <section class="connections-section" aria-labelledby="connections-heading">
    <div class="section-heading">
      <div>
        <h2 id="connections-heading">Connections <span id="site-count" class="count" hidden></span></h2>
        <p>Read access is included. Choose the write actions allowed for each connection.</p>
      </div>
      <div id="search-wrap" class="search" hidden>
        <label for="site-search">Find a connection</label>
        <input id="site-search" type="search" placeholder="Search by name or URL" autocomplete="off">
      </div>
    </div>
    <div id="sites" class="site-list"></div>
    <div id="sites-empty" class="empty-state">
      <strong>Load your connections</strong>
      <p>Enter the admin token above to see registered sites and manage their access.</p>
    </div>
    <p id="search-empty" class="empty-state" hidden>No connections match your search.</p>
  </section>

  <details id="new-connection" class="new-connection">
    <summary><span>Add a connection</span><span class="summary-hint">OAuth or fixed API token</span></summary>
    <div class="new-connection-body">
      <p class="section-help">Register a new site. Use the connection list above to change an existing site's access.</p>
      <form id="site-form">
        <div class="form-grid">
          <div><label for="display-name">Display name</label><input id="display-name" placeholder="Demo workspace" required maxlength="100"></div>
          <div><label for="base-url">NexWave site URL</label><input id="base-url" type="url" placeholder="https://your-site.example.com" required></div>
        </div>
        <div class="auth-select"><label for="auth-type">Authentication</label><select id="auth-type"><option value="oauth">OAuth 2</option><option value="api_token">Fixed API token</option></select></div>
        <div id="oauth-fields" class="auth-fields">
          <p class="hint">For interactive clients such as Claude and ChatGPT. Set the site's OAuth redirect URI to <code id="callback"></code>.</p>
          <div class="form-grid">
            <div><label for="client-id">OAuth client ID</label><input id="client-id" required maxlength="200" autocomplete="off"></div>
            <div><label for="client-secret">OAuth client secret</label><input id="client-secret" type="password" required autocomplete="new-password" maxlength="500"></div>
          </div>
        </div>
        <div id="api-token-fields" class="auth-fields" hidden>
          <p class="hint">For service clients such as voice agents. Use credentials from a dedicated NexWave user.</p>
          <div class="form-grid">
            <div><label for="api-key">API key</label><input id="api-key" type="password" autocomplete="new-password" maxlength="500"></div>
            <div><label for="api-secret">API secret</label><input id="api-secret" type="password" autocomplete="new-password" maxlength="500"></div>
          </div>
        </div>
        <fieldset class="permissions new-permissions">
          <legend>Write access <span class="optional">optional</span></legend>
          <p class="hint">Start with read-only access, then select only the actions this connection needs. NexWave user permissions still apply.</p>
          <div id="new-permissions" class="permission-grid"></div>
        </fieldset>
        <div class="form-footer"><button id="create-site" type="submit">Add connection</button><span id="auth-note" class="hint">OAuth clients must approve the selected write actions when connecting.</span></div>
        <p id="status" class="notice" role="status" aria-live="polite" hidden></p>
        <div id="service-token-panel" class="token-result" hidden>
          <strong>Copy your service token</strong>
          <p>This token is shown once. Store it before leaving this page.</p>
          <label for="service-token">Service token</label>
          <div class="copy-field"><input id="service-token" type="password" readonly autocomplete="off"><button id="copy-service-token" class="secondary" type="button">Copy token</button></div>
          <p id="copy-status" class="hint" role="status" aria-live="polite"></p>
        </div>
      </form>
    </div>
  </details>
  <footer class="page-footer">NexWave user permissions apply to every connection.</footer>
</main>
</body>
</html>`;
