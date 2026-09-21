import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticateServiceMcpRequest,
  handleServiceMcpRequest,
  SERVICE_MCP_TOKEN_HEADER,
} from "../src/service-mcp";
import { encryptSecret, sha256 } from "../src/security";
import type { Env, SiteRecord } from "../src/types";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("service MCP authentication", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps a valid gateway token to a registered site's API token", async () => {
    const site = await apiTokenSite();
    const result = await authenticateServiceMcpRequest(serviceRequest("gateway-token"), serviceEnv(site));

    expect(result).toEqual({
      props: {
        authType: "api_token",
        siteId: "site_test",
        siteName: "Demo",
        baseUrl: "https://demo.example.com",
        user: "service@example.com",
        upstreamApiKey: "api-key",
        upstreamApiSecret: "api-secret",
      },
    });
  });

  it("rejects a missing or invalid gateway token", async () => {
    const site = await apiTokenSite();
    const missing = await authenticateServiceMcpRequest(serviceRequest(), serviceEnv(site));
    const invalid = await authenticateServiceMcpRequest(serviceRequest("wrong-token"), serviceEnv(site));

    expect("response" in missing && missing.response.status).toBe(401);
    expect("response" in invalid && invalid.response.status).toBe(401);
  });

  it("rejects a disabled or unregistered site", async () => {
    const site = await apiTokenSite();
    const disabled = await authenticateServiceMcpRequest(
      serviceRequest("gateway-token"),
      serviceEnv({ ...site, enabled: 0 }),
    );
    const missing = await authenticateServiceMcpRequest(serviceRequest("gateway-token"), serviceEnv(null));

    expect("response" in disabled && disabled.response.status).toBe(403);
    expect("response" in missing && missing.response.status).toBe(401);
  });

  it("rejects a token mapped to an OAuth site", async () => {
    const site = await apiTokenSite();
    const oauthSite: SiteRecord = {
      ...site,
      auth_type: "oauth",
      client_id: "oauth-client-id",
      encrypted_client_secret: "encrypted-oauth-secret",
      encrypted_api_key: null,
      encrypted_api_secret: null,
      api_user: null,
    };

    const result = await authenticateServiceMcpRequest(serviceRequest("gateway-token"), serviceEnv(oauthSite));

    expect("response" in result && result.response.status).toBe(503);
  });

  it("accepts null values for optional tool arguments", async () => {
    const site = await apiTokenSite();
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: [{ name: "INV-00001", status: "Unpaid", outstanding_amount: 125 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleServiceMcpRequest(
      serviceToolRequest("gateway-token", "list_sales_invoices", {
        search: null,
        limit: 50,
        company: null,
        customer: null,
        status: "Unpaid",
        from_date: null,
        to_date: null,
      }),
      serviceEnv(site),
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const payload = JSON.parse(dataLine?.slice(6) ?? body) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(JSON.parse(payload.result?.content?.[0]?.text ?? "null")).toEqual([
      { name: "INV-00001", status: "Unpaid", outstanding_amount: 125 },
    ]);

    const [url] = fetchMock.mock.calls[0];
    const upstream = new URL(String(url));
    expect(JSON.parse(upstream.searchParams.get("filters") ?? "[]")).toEqual([
      ["Sales Invoice", "status", "=", "Unpaid"],
    ]);
  });

  it("lists purchase orders using bounded, permission-aware Frappe filters", async () => {
    const site = await apiTokenSite();
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: [{ name: "PO-00001", supplier: "SUP-00001", status: "To Receive and Bill" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleServiceMcpRequest(
      serviceToolRequest("gateway-token", "list_purchase_orders", {
        search: "Example",
        limit: 25,
        company: "Example Company",
        supplier: "SUP-00001",
        status: "To Receive and Bill",
        from_date: "2026-09-01",
        to_date: "2026-09-30",
      }),
      serviceEnv(site),
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(fetchMock, body).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    const upstream = new URL(String(url));
    expect(upstream.pathname).toBe("/api/resource/Purchase%20Order");
    expect(upstream.searchParams.get("limit_page_length")).toBe("25");
    expect(upstream.searchParams.get("order_by")).toBe("transaction_date desc");
    expect(JSON.parse(upstream.searchParams.get("filters") ?? "[]")).toEqual([
      ["Purchase Order", "company", "=", "Example Company"],
      ["Purchase Order", "supplier", "=", "SUP-00001"],
      ["Purchase Order", "status", "=", "To Receive and Bill"],
      ["Purchase Order", "transaction_date", ">=", "2026-09-01"],
      ["Purchase Order", "transaction_date", "<=", "2026-09-30"],
    ]);
    expect(JSON.parse(upstream.searchParams.get("or_filters") ?? "[]")).toEqual([
      ["Purchase Order", "name", "like", "%Example%"],
      ["Purchase Order", "supplier_name", "like", "%Example%"],
    ]);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "token api-key:api-secret",
    });
  });

  it("returns a parseable MCP error when the upstream sends HTML", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>private failure</html>")));
    const result = await invokeTool("list_suppliers", { search: "Example", limit: 5 });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "UPSTREAM_INVALID_RESPONSE", retryable: false } });
    expect(JSON.stringify(result)).not.toContain("private failure");
  });

  it.each(["get_sales_summary", "get_profit_and_loss"])("delivers conflicting date errors as JSON for %s", async (name) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleServiceMcpRequest(serviceToolRequest("gateway-token", name, {
      company: "Example Company", from_date: "2026-01-01", to_date: "2026-09-21",
      period: "current_fiscal_year", as_of_date: "2026-09-21",
      ...(name === "get_sales_summary" ? { group_by: "month" } : {}),
    }), serviceEnv(await apiTokenSite()), executionContext());
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json() as { id: number; result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.id).toBe(1);
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ error: { code: "INVALID_ARGUMENT", retryable: false } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delivers permission failures without upstream private content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private permission detail", { status: 403 })));
    const result = await invokeTool("list_suppliers", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("PERMISSION");
    expect(JSON.stringify(result)).not.toContain("private permission detail");
  });

  it("filters unpaid invoices across overdue and partly paid statuses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await invokeTool("list_purchase_invoices", { company: "Example Company", unpaid_only: true, sort_by: "due_date", sort_order: "asc", limit: 1 });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("order_by")).toBe("due_date asc");
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual([
      ["Purchase Invoice", "company", "=", "Example Company"],
      ["Purchase Invoice", "docstatus", "=", 1],
      ["Purchase Invoice", "outstanding_amount", ">", 0],
    ]);
  });

  it("rejects conflicting status filters and unsafe sorting before querying", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const args of [
      { status: "Paid", unpaid_only: true },
      { sort_by: "grand_total" },
      { sort_by: "base_grand_total" },
      { sort_by: "name desc; drop table" },
      { status: "Invented" },
      { customer_query: "   " },
    ]) {
      const result = await invokeTool("list_sales_invoices", args);
      expect(result.isError).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a spoken supplier query before filtering invoices", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({ data: [{ name: "SUP-001", supplier_name: "Example Office Ltd" }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ name: "INV-001", supplier: "SUP-001" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await invokeTool("list_purchase_invoices", { supplier_query: "Example Office Limited", company: "Example Company", from_date: "2026-09-01", limit: 5 });
    expect(result.isError).not.toBe(true);
    const url = new URL(String(fetchMock.mock.calls[2][0]));
    expect(JSON.parse(url.searchParams.get("filters")!)).toContainEqual(["Purchase Invoice", "supplier", "=", "SUP-001"]);
    expect(JSON.parse(url.searchParams.get("filters")!)).toContainEqual(["Purchase Invoice", "posting_date", ">=", "2026-09-01"]);
  });

  it("does not run a report for an ambiguous party", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [
      { name: "SUP-001", supplier_name: "Example One" },
      { name: "SUP-002", supplier_name: "Example Two" },
    ] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await invokeTool("get_party_balance", { company: "Example Company", party_type: "Supplier", query: "Example", report_date: "2026-09-21" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "candidates" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses equality for a confirmed long party ID and applies company-currency report filters", async () => {
    const partyId = "S".repeat(140);
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/Supplier")) return Response.json({ data: [{ name: partyId, supplier_name: "Example" }] });
      if (url.pathname.includes("/Company/")) return Response.json({ data: { default_currency: "NZD" } });
      const body = init!.body as URLSearchParams;
      expect(body.get("report_name")).toBe("Accounts Payable");
      expect(JSON.parse(body.get("filters")!)).toMatchObject({ company: "Example Company", party: [partyId], in_party_currency: 0, group_by_party: 0 });
      return Response.json({ message: { result: [{ party: partyId, voucher_no: "JE-001", posting_date: "2026-09-01", outstanding: 25 }] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await invokeTool("get_party_balance", { company: "Example Company", party_type: "Supplier", party_id: partyId, report_date: "2026-09-21" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "matched", totals: { outstanding: 25, overdue: 25 } });
    expect(JSON.parse(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("filters")!)).toContainEqual(["Supplier", "name", "=", partyId]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects trial balance ranges that cross a fiscal year or conflict with an explicit year", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ message: ["FY-2026", "2026-04-01", "2027-03-31"] }));
    vi.stubGlobal("fetch", fetchMock);
    for (const args of [
      { period: "last_90_days", as_of_date: "2026-05-15" },
      { fiscal_year: "FY-2026", from_date: "2025-09-01", to_date: "2025-09-21" },
    ]) {
      const result = await invokeTool("get_trial_balance", { company: "Example Company", ...args });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("both dates within the selected fiscal year");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url] of fetchMock.mock.calls) expect(String(url)).toContain("get_fiscal_year");
    const explicit = new URL(String(fetchMock.mock.calls[1][0]));
    expect(explicit.searchParams.get("fiscal_year")).toBe("FY-2026");
    expect(explicit.searchParams.has("date")).toBe(false);
  });

  it("preserves trial balance dates within the selected fiscal year", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ message: ["FY-2026", "2026-04-01", "2027-03-31"] }))
      .mockResolvedValueOnce(Response.json({ message: { result: [], columns: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await invokeTool("get_trial_balance", { company: "Example Company", fiscal_year: "FY-2026", from_date: "2026-04-01", to_date: "2026-09-21" });
    expect(result.isError).not.toBe(true);
    const body = (fetchMock.mock.calls[1][1] as RequestInit).body as URLSearchParams;
    expect(JSON.parse(body.get("filters")!)).toMatchObject({ fiscal_year: "FY-2026", from_date: "2026-04-01", to_date: "2026-09-21" });
  });

  it.each([12, { code: "NZD" }, null, "", "   "])("rejects invalid company currency %j in monetary flows", async (currency) => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.includes("/Company/")) return Response.json({ data: { name: "Example Company", default_currency: currency } });
      if (url.pathname.endsWith("/Supplier")) return Response.json({ data: [{ name: "SUP-001", supplier_name: "Example" }] });
      if (url.pathname.includes("/api/resource/")) return Response.json({ data: [{ name: "INV-001" }] });
      return Response.json({ message: { result: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    for (const [name, args] of [
      ["get_party_balance", { company: "Example Company", party_type: "Supplier", party_id: "SUP-001", report_date: "2026-09-21" }],
      ["get_accounts_payable_summary", { company: "Example Company", report_date: "2026-09-21" }],
      ["get_sales_summary", { company: "Example Company", from_date: "2026-09-01", to_date: "2026-09-21", group_by: "customer" }],
      ["list_sales_invoices", { company: "Example Company", sort_by: "base_grand_total" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await invokeTool(name, args);
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toContain("UPSTREAM_INVALID_RESPONSE");
    }
  });

  it.each([null, {}, { name: "   " }])("never runs a party report after a malformed exact lookup %j", async (row) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [row] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await invokeTool("get_party_balance", { company: "Example Company", party_type: "Supplier", party_id: "SUP-001", report_date: "2026-09-21" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("UPSTREAM_INVALID_RESPONSE");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts real Frappe array totals without double-counting the sales summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (new URL(input).pathname.includes("/Company/")) return Response.json({ data: { default_currency: "NZD" } });
      return Response.json({ message: {
        columns: ["invoice", "customer", "amount"].map((fieldname) => ({ fieldname })),
        result: [{ invoice: "INV-001", customer: "C-001", amount: 100 }, ["Total", "Total", 100]],
        add_total_row: true,
      } });
    }));
    const result = await invokeTool("get_sales_summary", { company: "Example Company", from_date: "2026-09-01", to_date: "2026-09-21", group_by: "customer" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ total_net_sales: 100, line_count: 1, group_count: 1 });
  });

  it("accepts real Frappe array totals in the payable summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (new URL(input).pathname.includes("/Company/")) return Response.json({ data: { default_currency: "NZD" } });
      return Response.json({ message: {
        columns: ["party", "voucher_no", "outstanding"].map((fieldname) => ({ fieldname })),
        result: [{ party: "SUP-001", voucher_no: "INV-001", outstanding: 100, posting_date: "2026-09-01" }, ["Total", "Total", 100]],
        add_total_row: true,
      } });
    }));
    const result = await invokeTool("get_accounts_payable_summary", { company: "Example Company", report_date: "2026-09-21" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ totals: { outstanding: 100 }, document_count: 1 });
  });

  it("returns structured metadata while preserving legacy list text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{ name: "SUP-001", supplier_name: "Example Supplier" }] })));
    const result = await invokeTool("list_suppliers", { search: "Example Supplier" });
    expect(JSON.parse(result.content[0].text)).toEqual([{ name: "SUP-001", supplier_name: "Example Supplier" }]);
    expect(result.structuredContent).toMatchObject({ meta: { match_status: "matched", count: 1 } });
  });
});

async function invokeTool(name: string, args: Record<string, unknown>) {
  const response = await handleServiceMcpRequest(serviceToolRequest("gateway-token", name, args), serviceEnv(await apiTokenSite()), executionContext());
  expect(response.status).toBe(200);
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const payload = JSON.parse(dataLine?.slice(6) ?? body);
  return payload.result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
}

function serviceRequest(token?: string): Request {
  const headers = token ? { [SERVICE_MCP_TOKEN_HEADER]: token } : undefined;
  return new Request("https://mcp.example.com/service/mcp", { method: "POST", headers });
}

function serviceToolRequest(
  token: string,
  toolName: string,
  args: Record<string, unknown>,
): Request {
  return new Request("https://mcp.example.com/service/mcp", {
    method: "POST",
    headers: {
      [SERVICE_MCP_TOKEN_HEADER]: token,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
}

function executionContext(): ExecutionContext {
  return {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
    props: Object.create(null),
  } as unknown as ExecutionContext;
}

function serviceEnv(site: SiteRecord | null): Env {
  const database = {
    prepare: () => ({
      bind: (tokenHash: unknown) => ({
        first: async () => tokenHash === site?.service_token_hash ? site : null,
      }),
    }),
  };
  return {
    ASSETS: Object.create(null) as Fetcher,
    ADMIN_TOKEN: "admin-token",
    CONFIG_ENCRYPTION_KEY: KEY,
    NEXWAVE_MCP_DB: Object.assign(Object.create(null) as D1Database, database),
    OAUTH_KV: Object.create(null) as KVNamespace,
    OAUTH_PROVIDER: Object.create(null) as Env["OAUTH_PROVIDER"],
  };
}

async function apiTokenSite(): Promise<SiteRecord> {
  return {
    id: "site_test",
    display_name: "Demo",
    base_url: "https://demo.example.com",
    auth_type: "api_token",
    client_id: null,
    encrypted_client_secret: null,
    encrypted_api_key: await encryptSecret("api-key", KEY),
    encrypted_api_secret: await encryptSecret("api-secret", KEY),
    api_user: "service@example.com",
    service_token_hash: await sha256("gateway-token"),
    enabled: 1,
    created_at: "2026-09-21 00:00:00",
    updated_at: "2026-09-21 00:00:00",
  };
}
