import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Use the runtime and bundler shipped with the lockfile-pinned Wrangler.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const bundle = await build({
  stdin: {
    resolveDir: root,
    contents: `
      import { exchangeFrappeCode, ensureFreshToken, getLoggedUser, getApiTokenUser, frappeList } from './src/frappe.ts';
      import { handleServiceMcpRequest } from './src/service-mcp.ts';
      import { encryptSecret, sha256 } from './src/security.ts';
      export default { async fetch(request) {
        const { operation, status, tool, args, errorFormat } = await request.json();
        if (operation === 'service-mcp') {
          const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
          const site = { id: 'site_test', display_name: 'Example', base_url: 'https://status-' + status + '.example.com', auth_type: 'api_token', enabled: 1,
            encrypted_api_key: await encryptSecret('test-key', key), encrypted_api_secret: await encryptSecret('test-secret', key), api_user: 'test@example.com' };
          const hash = await sha256('test-service-token');
          const env = { CONFIG_ENCRYPTION_KEY: key, NEXWAVE_MCP_DB: { prepare: () => ({ bind: (value) => ({ first: async () => value === hash ? site : null }) }) } };
          const mcpRequest = new Request('https://gateway.example.com/service/mcp', { method: 'POST', headers: {
            'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-NexWave-Service-Token': 'test-service-token',
            ...(errorFormat ? { 'X-MCP-Error-Format': errorFormat } : {})
          }, body: JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: tool, arguments: args } }) });
          return handleServiceMcpRequest(mcpRequest, env, { waitUntil() {} });
        }
        const baseUrl = 'https://upstream.example.com/' + status;
        const oauth = { authType: 'oauth', baseUrl, upstreamAccessToken: 'test-access', upstreamRefreshToken: 'test-refresh', upstreamExpiresAt: 0, upstreamClientId: 'test-client', upstreamClientSecret: 'test-secret' };
        const api = { authType: 'api_token', baseUrl, upstreamApiKey: 'test-key', upstreamApiSecret: 'test-secret' };
        // List URL construction uses an absolute API path, so pass the test status in the host.
        const listProps = { ...(operation === 'api-list' ? api : oauth), baseUrl: 'https://status-' + status + '.example.com' };
        try {
          let result;
          if (operation === 'exchange') result = await exchangeFrappeCode({ baseUrl, clientId: 'test-client', clientSecret: 'test-secret', code: 'test-code', codeVerifier: 'test-verifier', redirectUri: 'https://gateway.example.com/callback' });
          else if (operation === 'refresh') result = await ensureFreshToken(oauth);
          else if (operation === 'user') result = await getLoggedUser(baseUrl, 'test-access');
          else if (operation === 'api-user') result = await getApiTokenUser(baseUrl, 'test-key', 'test-secret');
          else result = await frappeList(listProps, 'Customer', ['name']);
          return Response.json({ ok: true, result });
        } catch (error) {
          return Response.json({ ok: false, code: error.code, retryable: error.retryable, message: error.message });
        }
      }};
    `,
  },
  bundle: true,
  format: "esm",
  write: false,
  external: ["cloudflare:*", "node:*"],
});

let upstreamCalls = 0;
let redirectTargetCalls = 0;
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  script: bundle.outputFiles[0].text,
  outboundService: async (request) => {
    upstreamCalls++;
    const url = new URL(request.url);
    if (url.hostname === "redirect.example.com") {
      redirectTargetCalls++;
      return new Response("Unexpected redirect target", { status: 500 });
    }
    const status = Number(url.hostname.startsWith("status-") ? url.hostname.split(/[.-]/)[1] : url.pathname.split("/")[1]);
    assert.ok([200, 301, 302, 303, 307, 308, 403, 404].includes(status));
    if (status >= 400) return new Response("Private upstream failure", { status });
    if (status !== 200) return new Response("Private redirect body", { status, headers: { Location: "https://redirect.example.com/private" } });
    if (url.pathname.endsWith("get_token")) {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("Authorization"), null);
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get("client_secret"), "test-secret");
      return Response.json({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 });
    }
    assert.ok(request.headers.get("Authorization"));
    return Response.json(url.pathname.endsWith("get_logged_user") ? { message: "test@example.com" } : { data: [{ name: "TEST-001" }] });
  },
}));

try {
  let checks = 0;
  for (const operation of ["exchange", "refresh", "user", "api-user", "oauth-list", "api-list"]) {
    for (const status of [200, 301, 302, 303, 307, 308]) {
      const before = upstreamCalls;
      const response = await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ operation, status }) });
      const result = await response.json();
      assert.equal(upstreamCalls - before, 1, operation + ": exactly one upstream request");
      assert.equal(result.ok, status === 200, operation + ": " + JSON.stringify(result));
      if (status !== 200) {
        assert.equal(result.code, "UPSTREAM_UNAVAILABLE");
        assert.equal(result.retryable, false);
        assert.ok(!result.message.includes("Private redirect body"));
        assert.ok(!result.message.includes("redirect.example.com"));
      } else if (operation === "exchange") assert.equal(result.result.access_token, "test-access");
      else if (operation === "refresh") assert.equal(result.result.upstreamAccessToken, "test-access");
      else if (operation.endsWith("user")) assert.equal(result.result, "test@example.com");
      else assert.deepEqual(result.result, [{ name: "TEST-001" }]);
      checks++;
    }
  }
  assert.equal(redirectTargetCalls, 0, "Credentials must never reach a redirect target");
  for (const errorFormat of [undefined, "result"]) for (const { status, tool, args, errorCode } of [
    { status: 200, tool: "list_suppliers", args: {} },
    { status: 403, tool: "list_suppliers", args: {}, errorCode: "PERMISSION_DENIED" },
    { status: 404, tool: "get_document", args: { doctype: "Sales Invoice", name: "TEST-MISSING" }, errorCode: "NOT_FOUND" },
    { status: 200, tool: "get_sales_summary", args: { company: "Example Company", group_by: "month", from_date: "2026-01-01", to_date: "2026-09-21", period: "current_fiscal_year", as_of_date: "2026-09-21" }, errorCode: "INVALID_ARGUMENT" },
  ]) {
    const response = await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ operation: "service-mcp", status, tool, args, errorFormat }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type"), /application\/json/);
    const body = await response.json();
    assert.equal(body.id, 17);
    if (errorCode) {
      assert.equal(body.result.isError, errorFormat !== "result");
      assert.equal(JSON.parse(body.result.content[0].text).error.code, errorCode);
      if (errorFormat === "result") {
        assert.equal(body.result.structuredContent.status, "error");
        assert.equal(body.result.structuredContent.ok, false);
      }
      assert.ok(!JSON.stringify(body).includes("Private upstream failure"));
    } else {
      assert.notEqual(body.result.isError, true);
      assert.deepEqual(JSON.parse(body.result.content[0].text), [{ name: "TEST-001" }]);
    }
    checks++;
  }
  console.log(checks + " Cloudflare runtime checks passed; no redirects followed.");
} finally {
  await mf.dispose();
}
