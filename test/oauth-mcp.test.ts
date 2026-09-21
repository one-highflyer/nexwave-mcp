import { afterEach, expect, it, vi } from "vitest";
import { mcpHandler } from "../src/mcp";
import type { Env, NexWaveOAuthAuthProps } from "../src/types";

const props: NexWaveOAuthAuthProps = {
  authType: "oauth", siteId: "site_test", siteName: "Example", baseUrl: "https://example.com",
  user: "user@example.com", upstreamAccessToken: "old-token", upstreamRefreshToken: "refresh-token",
  upstreamExpiresAt: Date.now() + 3_600_000, upstreamClientId: "client-id", upstreamClientSecret: "client-secret",
};

afterEach(() => vi.unstubAllGlobals());

it("keeps OAuth list calls and optional null arguments compatible", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{ name: "SUP-001", supplier_name: "Example" }] }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await callTool(props, "list_suppliers", { search: null, include_disabled: null });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].text)).toEqual([{ name: "SUP-001", supplier_name: "Example" }]);
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer old-token");
});

it("uses a refreshed OAuth token for the actual tool request", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ access_token: "fresh-token", refresh_token: "new-refresh", expires_in: 3600 }))
    .mockResolvedValueOnce(Response.json({ data: [] }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await callTool({ ...props, upstreamExpiresAt: Date.now() - 1 }, "list_suppliers", {});
  expect(result.isError).not.toBe(true);
  expect(String(fetchMock.mock.calls[0][0])).toContain("get_token");
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
});

it.each(["list_sales_invoices", "list_purchase_invoices"])("preserves OAuth invoice scope with optional null and All status for %s", async (tool) => {
  const fetchMock = vi.fn().mockImplementation(async () => Response.json({ data: [] }));
  vi.stubGlobal("fetch", fetchMock);
  for (const status of [null, "All"]) {
    const result = await callTool(props, tool, { company: "Example Company", status, unpaid_only: true, from_date: null, to_date: null, docstatus: null });
    expect(result.isError).not.toBe(true);
    const [input, init] = fetchMock.mock.calls.at(-1)!;
    expect(init.headers.Authorization).toBe("Bearer old-token");
    const filters = JSON.parse(new URL(String(input)).searchParams.get("filters")!);
    expect(filters.some((f: unknown[]) => f[1] === "status")).toBe(false);
    expect(filters.some((f: unknown[]) => f[1] === "outstanding_amount" && f[2] === ">" && f[3] === 0)).toBe(true);
  }
});

it.each([
  ["list_sales_invoices", { customer_query: "Example", status: "Paid", unpaid_only: true }],
  ["list_purchase_invoices", { supplier_query: "Example", status: "Submitted", overdue_as_of: "2026-06-30" }],
  ["list_sales_orders", { customer_query: "Example", pending_delivery: true, status: "Draft" }],
  ["list_purchase_orders", { supplier_query: "Example", pending_receipt: true, docstatus: 0 }],
] as const)("rejects invalid %s combinations before even refreshing an expired OAuth token", async (tool, args) => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const result = await callTool({ ...props, upstreamExpiresAt: Date.now() - 1 }, tool, args);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("INVALID_ARGUMENT");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("does not share upstream OAuth tokens between concurrent requests", async () => {
  const fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
    await Promise.resolve();
    const token = (init.headers as Record<string, string>).Authorization;
    return Response.json({ data: [{ name: token === "Bearer token-a" ? "SUP-A" : "SUP-B" }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const [first, second] = await Promise.all([
    callTool({ ...props, upstreamAccessToken: "token-a" }, "list_suppliers", {}),
    callTool({ ...props, siteId: "other-site", upstreamAccessToken: "token-b" }, "list_suppliers", {}),
  ]);
  expect(JSON.parse(first.content[0].text)).toEqual([{ name: "SUP-A" }]);
  expect(JSON.parse(second.content[0].text)).toEqual([{ name: "SUP-B" }]);
});

it.each([false, true])("preserves OAuth errors even with service compatibility header %s", async (compatibilityHeader) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("private upstream response", { status: 403 }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await callTool(props, "list_suppliers", { search: "Example" }, compatibilityHeader);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("PERMISSION_DENIED");
  expect(result.content[0].text).not.toContain("private upstream");
  expect(fetchMock).toHaveBeenCalledOnce();
});

async function callTool(authProps: NexWaveOAuthAuthProps, name: string, args: Record<string, unknown>, compatibilityHeader = false) {
  // Simulate the trusted context supplied by the OAuth provider after verification.
  const context = {
    props: authProps,
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    [Symbol.for("cloudflare.workers-oauth-provider.verified-context.v1")]: {
      version: 1, token: "gateway-token", clientId: "test-client", scopes: ["nexwave:read"], props: authProps,
    },
  } as unknown as ExecutionContext;
  const response = await mcpHandler(new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(compatibilityHeader ? { "X-MCP-Error-Format": "result" } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), {} as Env, context);
  expect(response.status).toBe(200);
  const body = await response.text();
  const line = body.split("\n").find((value) => value.startsWith("data: "));
  return JSON.parse(line?.slice(6) ?? body).result as { isError?: boolean; content: Array<{ text: string }> };
}
