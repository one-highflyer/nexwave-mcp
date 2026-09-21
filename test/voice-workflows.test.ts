import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleServiceMcpRequest,
  SERVICE_MCP_TOKEN_HEADER,
} from "../src/service-mcp";
import { encryptSecret, sha256 } from "../src/security";
import type { Env, SiteRecord } from "../src/types";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

afterEach(() => vi.unstubAllGlobals());

describe("voice workflows through the public service MCP endpoint", () => {
  it("does not let a loose full-phrase hit hide an exact legal-name variant", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/Supplier")) {
        const orFilters = JSON.parse(url.searchParams.get("or_filters") ?? "[]") as unknown[][];
        const fullPhrase = orFilters.some((filter) => filter[3] === "%Example Office Limited%");
        return Response.json({ data: fullPhrase
          ? [{ name: "SUP-OTHER", supplier_name: "Example Office Limited Holdings" }]
          : [
              { name: "SUP-001", supplier_name: "Example Office Ltd" },
              { name: "SUP-OTHER", supplier_name: "Example Office Limited Holdings" },
            ] });
      }
      if (url.pathname.includes("/Company/")) return Response.json({ data: { default_currency: "NZD" } });
      return Response.json({ message: { result: [
        { party: "SUP-001", voucher_no: "PINV-001", due_date: "2026-09-01", outstanding: 125 },
      ] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeTool("get_party_balance", {
      company: "Example Company",
      party_type: "Supplier",
      query: "Example Office Limited",
      report_date: "2026-09-21",
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: "matched",
      party: "SUP-001",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("asks about a spoken code collision, then honours the confirmed exact party ID", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/Supplier")) {
        const filters = JSON.parse(url.searchParams.get("filters") ?? "[]") as unknown[][];
        if (filters.some((filter) => filter[1] === "name" && filter[2] === "=" && filter[3] === "SUP-001")) {
          return Response.json({ data: [{ name: "SUP-001", supplier_name: "Example Office" }] });
        }
        return Response.json({ data: [
          { name: "SUP-001", supplier_name: "Example Office" },
          { name: "SUP-002", supplier_name: "SUP-001" },
        ] });
      }
      if (url.pathname.includes("/Company/")) return Response.json({ data: { default_currency: "NZD" } });
      return Response.json({ message: { result: [
        { party: "SUP-001", voucher_no: "PINV-001", due_date: "2026-09-01", outstanding: 125 },
      ] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ambiguous = await invokeTool("get_party_balance", {
      company: "Example Company",
      party_type: "Supplier",
      query: "SUP-001",
      report_date: "2026-09-21",
    });

    expect(ambiguous.isError).not.toBe(true);
    expect(JSON.parse(ambiguous.content[0].text)).toMatchObject({ status: "candidates" });
    expect(fetchMock).toHaveBeenCalledOnce();

    const confirmed = await invokeTool("get_party_balance", {
      company: "Example Company",
      party_type: "Supplier",
      party_id: "SUP-001",
      report_date: "2026-09-21",
    });

    expect(confirmed.isError).not.toBe(true);
    expect(JSON.parse(confirmed.content[0].text)).toMatchObject({
      status: "matched",
      party: "SUP-001",
      totals: { outstanding: 125 },
    });
  });

  it("preserves transaction filters after a spoken party is resolved", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/Customer")) {
        return Response.json({ data: [{ name: "CUS-001", customer_name: "Example Retail Limited" }] });
      }
      return Response.json({ data: [{ name: "SINV-001", customer: "CUS-001", outstanding_amount: 80 }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeTool("list_sales_invoices", {
      customer_query: "Example Retail Ltd",
      company: "Example Company",
      unpaid_only: true,
      from_date: "2026-08-01",
      to_date: "2026-09-21",
      sort_by: "due_date",
      sort_order: "asc",
      limit: 3,
    });

    expect(result.isError).not.toBe(true);
    const transactionUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(transactionUrl.searchParams.get("order_by")).toBe("due_date asc");
    expect(JSON.parse(transactionUrl.searchParams.get("filters")!)).toEqual([
      ["Sales Invoice", "company", "=", "Example Company"],
      ["Sales Invoice", "customer", "=", "CUS-001"],
      ["Sales Invoice", "posting_date", ">=", "2026-08-01"],
      ["Sales Invoice", "posting_date", "<=", "2026-09-21"],
      ["Sales Invoice", "docstatus", "=", 1],
      ["Sales Invoice", "outstanding_amount", ">", 0],
    ]);
  });

  it("returns an INVALID_ARGUMENT tool error for an impossible calendar date", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeTool("get_party_balance", {
      company: "Example Company",
      party_type: "Customer",
      query: "Example Retail",
      report_date: "2026-02-30",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("INVALID_ARGUMENT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { caseName: "unknown row shape", rows: [{ message: "unexpected report shape" }] },
    { caseName: "string monetary fields", rows: [{ party: "CUS-001", voucher_no: "SINV-001", outstanding: "125", range1: "125" }] },
    { caseName: "financial-looking row without a voucher or subtotal marker", rows: [{ party: "CUS-001", outstanding: 0 }] },
  ])("rejects malformed receivables: $caseName", async ({ rows }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      message: { result: rows },
    })));

    const result = await invokeTool("get_accounts_receivable_summary", {
      company: "Example Company",
      report_date: "2026-09-21",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("UPSTREAM_INVALID_RESPONSE");
  });

  it("keeps a completed empty receivables report distinct from an upstream error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: { result: [] } })));

    const result = await invokeTool("get_accounts_receivable_summary", {
      company: "Example Company",
      report_date: "2026-09-21",
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      totals: { outstanding: 0 },
      customer_count: 0,
      invoice_count: 0,
    });
  });

  it("separates positive receivables from customer credits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: { result: [
      { party: "CUS-001", voucher_no: "SINV-001", outstanding: 100, range1: 100, currency: "NZD" },
      { party: "CUS-001", bold: 1, outstanding: 100, range1: 100, currency: "NZD" },
      {},
      { party: "CUS-002", voucher_no: "PAY-001", outstanding: -25, currency: "NZD" },
      { party: "CUS-002", bold: 1, outstanding: -25, currency: "NZD" },
      {},
      { party: "Total", bold: 1, outstanding: 75, range1: 100, currency: "NZD" },
    ] } })));

    const result = await invokeTool("get_accounts_receivable_summary", {
      company: "Example Company",
      report_date: "2026-09-21",
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      totals: {
        outstanding: 75,
        positive_outstanding: 100,
        credit_balance: 25,
      },
    });
  });
});

type ToolResult = {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
};

async function invokeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const response = await handleServiceMcpRequest(
    serviceToolRequest("gateway-token", name, args),
    serviceEnv(await apiTokenSite()),
    executionContext(),
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const payload = JSON.parse(dataLine?.slice(6) ?? body);
  return payload.result as ToolResult;
}

function serviceToolRequest(token: string, toolName: string, args: Record<string, unknown>): Request {
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

function serviceEnv(site: SiteRecord): Env {
  const database = {
    prepare: () => ({
      bind: (tokenHash: unknown) => ({
        first: async () => tokenHash === site.service_token_hash ? site : null,
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
