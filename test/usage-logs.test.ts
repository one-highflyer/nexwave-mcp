import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { mcpHandler } from "../src/mcp";
import { handleServiceMcpRequest } from "../src/service-mcp";
import { encryptSecret, sha256 } from "../src/security";
import type { Env, NexWaveOAuthAuthProps, SiteRecord } from "../src/types";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const oauth: NexWaveOAuthAuthProps = {
  authType: "oauth", siteId: "site_test", siteName: "Example", baseUrl: "https://example.com",
  user: "private-user@example.com", upstreamAccessToken: "private-access-token",
  upstreamRefreshToken: "private-refresh-token", upstreamExpiresAt: Date.now() + 3_600_000,
  upstreamClientId: "private-client-id", upstreamClientSecret: "private-client-secret",
};
type Mode = "oauth" | "api_token";

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => undefined));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each<Mode>(["oauth", "api_token"])("logs the verified site and successful tool outcome for %s", async (mode) => {
  const before = Date.now();
  const response = await request(mode, "tools/call", {
    name: "get_current_user",
    arguments: { site_name: "untrusted-site", token: "private-argument", user: "untrusted-user" },
  });
  expect(response.payload.result.isError).not.toBe(true);
  expect(usage()).toHaveLength(1);
  expect(usage()[0]).toEqual({
    event: "mcp_request", site_id: "site_test", site_name: "Example", auth_type: mode,
    timestamp: expect.any(String), request_id: expect.any(String), method: "tools/call",
    tool: "get_current_user", outcome: "success", error_code: null, duration_ms: expect.any(Number),
  });
  expect(Date.parse(usage()[0].timestamp)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(usage()[0].timestamp)).toBeLessThanOrEqual(Date.now());
  expect(usage()[0].duration_ms).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(usage())).not.toMatch(/private-|untrusted-|example\.com/);
});

it.each<Mode>(["oauth", "api_token"])("logs discovery requests separately from tool calls for %s", async (mode) => {
  await request(mode, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  await request(mode, "tools/list", {});
  expect(usage()).toMatchObject([
    { method: "initialize", tool: null, outcome: "success", auth_type: mode },
    { method: "tools/list", tool: null, outcome: "success", auth_type: mode },
  ]);
});

it.each<Mode>(["oauth", "api_token"])("logs HTTP 200 tool failures for %s without private data", async (mode) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private-upstream-body", { status: 403 })));
  const { status, payload } = await request(mode, "tools/call", { name: "list_suppliers", arguments: { search: "private-search" } });
  expect(status).toBe(200);
  expect(payload.result.isError).toBe(true);
  expect(usage()).toMatchObject([{ auth_type: mode, tool: "list_suppliers", outcome: "error", error_code: "PERMISSION_DENIED" }]);
  expect(JSON.stringify(usage())).not.toMatch(/private-|example\.com/);
});

it("logs the original failure before the service compatibility response hides isError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private-upstream-body", { status: 403 })));
  const { payload } = await request("api_token", "tools/call", { name: "list_suppliers", arguments: {} }, oauth, { "X-MCP-Error-Format": "result" });
  expect(payload.result.isError).toBe(false);
  expect(payload.result.structuredContent.ok).toBe(false);
  expect(usage()).toMatchObject([{ outcome: "error", error_code: "PERMISSION_DENIED" }]);
});

it.each<Mode>(["oauth", "api_token"])("logs schema failures before tool execution for %s", async (mode) => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await request(mode, "tools/call", { name: "list_suppliers", arguments: { limit: -1 } });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(usage()).toMatchObject([{ tool: "list_suppliers", outcome: "error", error_code: "INVALID_ARGUMENT" }]);
});

it.each<Mode>(["oauth", "api_token"])("does not log arbitrary tool or method names for %s", async (mode) => {
  await request(mode, "tools/call", { name: "private-unknown-tool", arguments: {} });
  await request(mode, "private-unknown-method", {});
  expect(usage()).toMatchObject([
    { tool: "unknown", outcome: "error" },
    { method: "unknown", tool: null, outcome: "error", error_code: "METHOD_NOT_FOUND" },
  ]);
  expect(JSON.stringify(usage())).not.toContain("private-");
});

it.each<Mode>(["oauth", "api_token"])("observes modern JSON replies as well as legacy SSE for %s", async (mode) => {
  const { payload } = await request(mode, "tools/call", {
    name: "get_current_user", arguments: {}, _meta: {
      [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_META_KEY]: {},
      [CLIENT_INFO_META_KEY]: { name: "test", version: "1" },
    },
  }, oauth, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "get_current_user" });
  expect(payload, JSON.stringify(payload)).toHaveProperty("result");
  expect(usage()).toMatchObject([{ tool: "get_current_user", outcome: "success", auth_type: mode }]);
});

it("keeps customer identity and request IDs separate during concurrent OAuth and service calls", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Response.json({ data: [] });
  }));
  await Promise.all([
    request("oauth", "tools/call", { name: "list_suppliers", arguments: {} }),
    request("api_token", "tools/call", { name: "list_customers", arguments: {} }, { ...oauth, siteId: "other-site", siteName: "Other Example" }),
  ]);
  expect(usage()).toHaveLength(2);
  expect(usage()).toEqual(expect.arrayContaining([
    expect.objectContaining({ site_id: "site_test", site_name: "Example", auth_type: "oauth", tool: "list_suppliers" }),
    expect.objectContaining({ site_id: "other-site", site_name: "Other Example", auth_type: "api_token", tool: "list_customers" }),
  ]));
  expect(new Set(usage().map((entry) => entry.request_id)).size).toBe(2);
});

it("does not change responses if the logger fails", async () => {
  vi.mocked(console.log).mockImplementation((entry) => { if (entry?.event === "mcp_request") throw new Error("logger unavailable"); });
  const { payload } = await request("oauth", "tools/call", { name: "get_current_user", arguments: {} });
  expect(payload.result.isError).not.toBe(true);
});

it("records a connection closed during a tool call once, without a later success", async () => {
  const controller = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const upstreamStarted = new Promise<void>((resolve) => { entered = resolve; });
  vi.stubGlobal("fetch", vi.fn(async () => {
    entered();
    await gate;
    return Response.json({ data: [] });
  }));
  const pending = request("oauth", "tools/call", { name: "list_suppliers", arguments: {} }, oauth, {}, controller.signal).catch(() => undefined);
  await upstreamStarted;
  controller.abort();
  release();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(usage()).toMatchObject([{ tool: "list_suppliers", outcome: "cancelled", error_code: "CONNECTION_CLOSED" }]);
  expect(usage()).toHaveLength(1);
});

function usage() {
  return vi.mocked(console.log).mock.calls.map(([entry]) => entry).filter((entry) => entry?.event === "mcp_request");
}

async function request(mode: Mode, method: string, params: Record<string, unknown>, props = oauth, headers: Record<string, string> = {}, signal?: AbortSignal) {
  const req = new Request(`https://mcp.example.com/${mode === "oauth" ? "mcp" : "service/mcp"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer private-bearer", "X-NexWave-Service-Token": "private-service-token", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  const context = {
    props,
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    [Symbol.for("cloudflare.workers-oauth-provider.verified-context.v1")]: {
      version: 1, token: "private-bearer", clientId: "test-client", scopes: ["nexwave:read"], props,
    },
  } as unknown as ExecutionContext;
  let response: Response;
  if (mode === "oauth") response = await mcpHandler(req, {} as Env, context);
  else {
    const site: SiteRecord = {
      id: props.siteId, display_name: props.siteName, base_url: props.baseUrl, auth_type: "api_token", enabled: 1,
      client_id: null, encrypted_client_secret: null, api_user: props.user,
      encrypted_api_key: await encryptSecret("private-api-key", KEY),
      encrypted_api_secret: await encryptSecret("private-api-secret", KEY),
      service_token_hash: await sha256("private-service-token"), created_at: "", updated_at: "",
    };
    const env = {
      CONFIG_ENCRYPTION_KEY: KEY,
      NEXWAVE_MCP_DB: { prepare: () => ({ bind: (hash: string) => ({ first: async () => hash === site.service_token_hash ? site : null }) }) },
    } as unknown as Env;
    // The service route must use its own token lookup, not the OAuth context.
    response = await handleServiceMcpRequest(req, env, { props: {}, waitUntil: () => undefined } as unknown as ExecutionContext);
  }
  const body = await response.text();
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  return { status: response.status, payload: JSON.parse(data?.slice(6) ?? body) };
}
