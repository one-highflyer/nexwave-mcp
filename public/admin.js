"use strict";

const $ = (id) => document.getElementById(id);
const capabilities = [
  { key: "quotations", title: "Quotations", description: "Create and update drafts" },
  { key: "leads", title: "Leads", description: "Create leads" },
  { key: "customers", title: "Customers", description: "Create customers" },
  { key: "sales_orders", title: "Sales orders", description: "Create and update drafts" },
  { key: "purchase_invoices", title: "Purchase invoices", description: "Create and update drafts" },
];
const token = () => $("admin-token").value.trim();
const headers = () => ({ Authorization: "Bearer " + token(), "Content-Type": "application/json" });
let loading = false;
let loaded = false;
let mutating = false;
const siteUpdates = new Set();

function syncControls() {
  $("load").disabled = loading || mutating;
  $("create-site").disabled = loading || mutating;
  for (const id of ["display-name", "base-url", "auth-type"]) $(id).disabled = loading || mutating;
  for (const { input } of newChecks) input.disabled = loading || mutating;
  syncAuthFields();
  for (const update of siteUpdates) update();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function notice(node, text, kind = "info") {
  node.textContent = text;
  node.hidden = !text;
  node.dataset.kind = kind;
  node.setAttribute("role", kind === "error" ? "alert" : "status");
}
function rememberToken() {
  try { sessionStorage.setItem("nexwave_mcp_admin_token", token()); } catch { /* Storage is optional. */ }
}
function permissionOptions(container, selected, prefix) {
  return capabilities.map(({ key, title, description }) => {
    const label = element("label", "permission");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = prefix + key;
    input.checked = selected.includes(key);
    const copy = element("span", "permission-copy");
    copy.append(element("strong", "", title), element("small", "", description));
    label.append(input, copy);
    container.append(label);
    return { key, input };
  });
}
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: headers(), cache: "no-store" });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const message = response.status === 401 ? "Admin token not accepted. Check the token and try again."
      : typeof data?.error === "string" ? data.error : "The request failed. Try again.";
    throw new Error(message);
  }
  return data;
}

function renderSite(site, index) {
  const article = element("article", "site");
  article.dataset.search = [site.displayName, site.baseUrl, site.apiUser ?? "", site.authType].join(" ").toLowerCase();
  const title = element("h3", "", site.displayName);
  title.id = "site-title-" + index;
  article.setAttribute("aria-labelledby", title.id);
  const heading = element("div", "site-heading");
  heading.append(title, element("span", "site-url", site.baseUrl));
  const top = element("div", "site-top");
  const remove = element("button", "remove", "Remove");
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove " + site.displayName);
  top.append(heading, remove);
  const meta = element("div", "site-meta");
  meta.append(element("span", "auth-badge", site.authType === "api_token" ? "Fixed API token" : "OAuth 2"));
  const badge = element("span", "access-badge");
  meta.append(badge);
  if (site.apiUser) meta.append(element("span", "site-user", site.apiUser));
  if (!site.enabled) meta.append(element("span", "auth-badge", "Disabled"));
  const permissions = element("fieldset", "permissions");
  permissions.append(element("legend", "", "Write access"));
  const grid = element("div", "permission-grid");
  permissions.append(grid);
  let saved = capabilities.filter(({ key }) => (site.writeCapabilities || []).includes(key)).map(({ key }) => key);
  const checks = permissionOptions(grid, saved, "site-" + index + "-");
  const selected = () => checks.filter(({ input }) => input.checked).map(({ key }) => key);
  const footer = element("div", "site-footer");
  const state = element("span", "save-state", "No changes");
  const save = element("button", "secondary", "Save access");
  save.type = "button";
  save.disabled = true;
  save.setAttribute("aria-label", "Save access for " + site.displayName);
  footer.append(state, save);
  const status = element("p", "notice site-status");
  status.hidden = true;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  article.append(top, meta, permissions, footer, status);
  let saving = false;
  let removing = false;
  const update = () => {
    const dirty = JSON.stringify(saved) !== JSON.stringify(selected());
    save.disabled = loading || mutating || saving || removing || !dirty;
    remove.disabled = loading || mutating || saving || removing;
    for (const { input } of checks) input.disabled = loading || mutating || saving || removing;
    state.textContent = dirty ? "Unsaved changes" : "No changes";
    state.dataset.dirty = String(dirty);
    badge.textContent = saved.length ? saved.length + (saved.length === 1 ? " write action" : " write actions") : "Read-only";
    badge.dataset.write = String(saved.length > 0);
  };
  for (const { input } of checks) input.addEventListener("change", () => { notice(status, ""); update(); });
  save.addEventListener("click", async () => {
    if (loading || mutating || saving || removing) return;
    const next = selected();
    const added = next.some((key) => !saved.includes(key));
    saving = true;
    mutating = true;
    save.textContent = "Saving…";
    article.setAttribute("aria-busy", "true");
    for (const { input } of checks) input.disabled = true;
    remove.disabled = true;
    syncControls();
    notice(status, "");
    try {
      await request("/api/admin/sites/" + encodeURIComponent(site.id) + "/capabilities", {
        method: "PATCH", body: JSON.stringify({ writeCapabilities: next }),
      });
      saved = next;
      const text = site.authType === "oauth" && added
        ? "Access saved. Reconnect your MCP client and approve the new write actions."
        : "Access saved.";
      notice(status, text, "success");
    } catch (error) { notice(status, error.message || "Could not save access. Try again.", "error"); }
    finally {
      saving = false;
      mutating = false;
      save.textContent = "Save access";
      article.removeAttribute("aria-busy");
      for (const { input } of checks) input.disabled = false;
      remove.disabled = false;
      syncControls();
    }
  });
  remove.addEventListener("click", async () => {
    if (loading || mutating || saving || removing) return;
    if (!confirm("Remove " + site.displayName + "? This deletes the saved connection settings.")) return;
    removing = true;
    mutating = true;
    remove.disabled = true;
    save.disabled = true;
    for (const { input } of checks) input.disabled = true;
    syncControls();
    try {
      await request("/api/admin/sites/" + encodeURIComponent(site.id), { method: "DELETE" });
      article.remove();
      siteUpdates.delete(update);
      filterSites();
    } catch (error) { notice(status, error.message || "Could not remove the connection.", "error"); }
    finally {
      removing = false;
      mutating = false;
      remove.disabled = false;
      for (const { input } of checks) input.disabled = false;
      syncControls();
    }
  });
  siteUpdates.add(update);
  update();
  return article;
}

function filterSites() {
  const query = $("site-search").value.trim().toLowerCase();
  const sites = [...$("sites").children];
  for (const site of sites) site.hidden = !site.dataset.search.includes(query);
  const count = sites.filter((site) => !site.hidden).length;
  $("site-count").textContent = query ? count + " / " + sites.length : String(sites.length);
  $("site-count").hidden = !loaded;
  $("search-wrap").hidden = !sites.length;
  $("search-empty").hidden = !sites.length || count > 0;
  $("sites-empty").hidden = !loaded || sites.length > 0;
  if (loaded && !sites.length) {
    $("sites-empty").replaceChildren(element("strong", "", "No connections yet"), element("p", "", "Use Add a connection below to register your first NexWave site."));
  }
}
async function loadSites(afterCreation = false) {
  if (loading || (mutating && !afterCreation)) return;
  loading = true;
  syncControls();
  $("load").textContent = "Loading…";
  $("access-form").setAttribute("aria-busy", "true");
  notice($("access-status"), "");
  rememberToken();
  try {
    const sites = await request("/api/admin/sites");
    if (!Array.isArray(sites)) throw new Error("Could not read the connection list. Try again.");
    siteUpdates.clear();
    $("sites").replaceChildren(...sites.map(renderSite));
    loaded = true;
    filterSites();
    notice($("access-status"), "Connections loaded. Access changes are saved separately for each connection.", "success");
  } catch (error) { notice($("access-status"), error.message || "Could not load connections. Try again.", "error"); }
  finally {
    loading = false;
    syncControls();
    $("load").textContent = loaded ? "Refresh connections" : "Load connections";
    $("access-form").removeAttribute("aria-busy");
  }
}
function syncAuthFields() {
  const oauth = $("auth-type").value === "oauth";
  $("oauth-fields").hidden = !oauth;
  $("api-token-fields").hidden = oauth;
  for (const id of ["client-id", "client-secret"]) { $(id).required = oauth; $(id).disabled = loading || mutating || !oauth; }
  for (const id of ["api-key", "api-secret"]) { $(id).required = !oauth; $(id).disabled = loading || mutating || oauth; }
  $("auth-note").textContent = oauth ? "OAuth clients must approve the selected write actions when connecting." : "The service token is shown once after this connection is saved.";
}

try { $("admin-token").value = sessionStorage.getItem("nexwave_mcp_admin_token") || ""; } catch { /* Storage is optional. */ }
$("callback").textContent = location.origin + "/oauth/frappe/callback";
const newChecks = permissionOptions($("new-permissions"), [], "write-");
syncAuthFields();
$("auth-type").addEventListener("change", syncAuthFields);
$("site-search").addEventListener("input", filterSites);
$("access-form").addEventListener("submit", (event) => { event.preventDefault(); loadSites(); });
$("site-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!token()) { $("admin-token").reportValidity(); $("admin-token").focus(); return; }
  const create = $("create-site");
  if (loading || mutating || create.disabled) return;
  mutating = true;
  create.disabled = true;
  syncControls();
  create.textContent = "Adding…";
  notice($("status"), "");
  $("service-token-panel").hidden = true;
  $("service-token").value = "";
  $("copy-status").textContent = "";
  rememberToken();
  const body = {
    displayName: $("display-name").value, baseUrl: $("base-url").value,
    authType: $("auth-type").value, clientId: $("client-id").value, clientSecret: $("client-secret").value,
    apiKey: $("api-key").value, apiSecret: $("api-secret").value,
    writeCapabilities: newChecks.filter(({ input }) => input.checked).map(({ key }) => key),
  };
  try {
    const data = await request("/api/admin/sites", { method: "POST", body: JSON.stringify(body) });
    $("site-form").reset();
    syncAuthFields();
    notice($("status"), "Connection added.", "success");
    if (data?.serviceToken) {
      $("service-token").value = data.serviceToken;
      $("service-token-panel").hidden = false;
      $("copy-service-token").textContent = "Copy token";
    }
    $("site-search").value = "";
    await loadSites(true);
  } catch (error) { notice($("status"), error.message || "Could not add the connection. Try again.", "error"); }
  finally { mutating = false; syncControls(); create.textContent = "Add connection"; }
});
$("copy-service-token").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("service-token").value);
    $("copy-service-token").textContent = "Copied";
    $("copy-status").textContent = "Service token copied.";
  } catch { $("copy-status").textContent = "Copy was blocked. Select the service token and copy it manually."; }
});
