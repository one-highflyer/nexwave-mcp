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
      export default { async fetch(request) {
        const { operation, status } = await request.json();
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
    assert.ok([200, 301, 302, 303, 307, 308].includes(status));
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
  console.log(checks + " Cloudflare runtime checks passed; no redirects followed.");
} finally {
  await mf.dispose();
}
