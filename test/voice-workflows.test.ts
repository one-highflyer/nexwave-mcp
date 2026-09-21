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
  it.each([
    ["list_sales_invoices", { customer_query: "Example Retail", unpaid_only: true, status: "Submitted" }],
    ["list_purchase_invoices", { supplier_query: "Example Office", unpaid_only: true, status: "Paid" }],
    ["list_sales_invoices", { customer_query: "Example Retail", overdue_as_of: "2026-06-30", status: "Unpaid" }],
    ["list_purchase_invoices", { supplier_query: "Example Office", overdue_as_of: "2026-06-30", docstatus: 0 }],
    ["list_sales_orders", { customer_query: "Example Retail", pending_delivery: true, status: "To Deliver" }],
    ["list_purchase_orders", { supplier_query: "Example Office", pending_receipt: true, status: "To Receive" }],
    ["list_sales_orders", { customer_query: "Example Retail", status: "To Receive" }],
    ["list_purchase_orders", { supplier_query: "Example Office", status: "To Deliver" }],
    ["list_sales_invoices", { customer_query: "Example Retail", status: "Debit Note Issued" }],
    ["list_purchase_invoices", { supplier_query: "Example Office", status: "Credit Note Issued" }],
    ["list_sales_orders", { customer_query: "Example Retail", delivery_from_date: "2026-06-30", delivery_to_date: "2026-06-01" }],
    ["list_purchase_orders", { supplier_query: "Example Office", from_date: "2026-02-30" }],
    ["list_sales_invoices", { customer_query: "Example Retail", sort_by: "grand_total" }],
    ["list_purchase_invoices", { supplier_query: "Example Office", sort_by: "base_grand_total" }],
  ] as const)("rejects invalid %s filters before any upstream call: %j", async (tool, args) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await invokeTool(tool, args);
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["list_sales_invoices", "Sales Invoice", "customer", "CUS-001"],
    ["list_purchase_invoices", "Purchase Invoice", "supplier", "SUP-001"],
  ])("accepts All, null and omitted status for %s without narrowing unpaid invoices", async (tool, doctype, party, id) => {
    for (const status of ["All", null, undefined]) {
      const fetchMock = vi.fn(async (_input: string) => Response.json({ data: [{ name: "INV-001" }] }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await invokeTool(tool, { company: "Example Company", [party]: id, status, unpaid_only: true, docstatus: 1 });
      expect(result.isError).not.toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
      const filters = JSON.parse(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("filters")!);
      expect(filters).toContainEqual([doctype, "outstanding_amount", ">", 0]);
      expect(filters).toContainEqual([doctype, "docstatus", "=", 1]);
      expect(filters.some((f: unknown[]) => f[1] === "status")).toBe(false);
    }
  });

  it.each([
    ["list_sales_orders", "Sales Order", "customer", "Customer", "CUS-001", "pending_delivery", "delivery_date"],
    ["list_purchase_orders", "Purchase Order", "supplier", "Supplier", "SUP-001", "pending_receipt", "schedule_date"],
  ])("resolves the party and filters expected delivery dates for %s", async (tool, doctype, party, partyType, id, pending, deliveryField) => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith(`/${partyType}`)) return Response.json({ data: [{ name: id, [`${party}_name`]: "Example Office" }] });
      return Response.json({ data: [{ name: "ORDER-001" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await invokeTool(tool, {
      company: "Example Company", [`${party}_query`]: "Example Office", status: "All", [pending]: true,
      delivery_from_date: "2026-06-01", delivery_to_date: "2026-06-30", sort_by: deliveryField, sort_order: "asc",
    });
    expect(result.isError).not.toBe(true);
    const url = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(url.searchParams.get("order_by")).toBe(`${deliveryField} asc`);
    const filters = JSON.parse(url.searchParams.get("filters")!);
    expect(filters).toEqual(expect.arrayContaining([
      [doctype, party, "=", id], [doctype, deliveryField, ">=", "2026-06-01"], [doctype, deliveryField, "<=", "2026-06-30"],
      [doctype, "docstatus", "=", 1],
    ]));
    expect(filters.some((f: unknown[]) => f[1] === "transaction_date" || f[1] === "status" && f[2] === "=")).toBe(false);
  });

  it.each(["list_projects", "list_payments", "list_bank_transactions"])("treats All as no status filter for %s", async (tool) => {
    const fetchMock = vi.fn(async (_input: string) => Response.json({ data: [{ name: "RECORD-001" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await invokeTool(tool, { company: "Example Company", status: "All" });
    expect(result.isError).not.toBe(true);
    const filters = JSON.parse(new URL(fetchMock.mock.calls[0][0]).searchParams.get("filters")!);
    expect(filters.some((f: unknown[]) => f[1] === "status")).toBe(false);
  });

  it.each([
    ["list_sales_orders", "pending_delivery"], ["list_purchase_orders", "pending_receipt"],
  ])("discloses header-date scope even for empty %s delivery results", async (tool, pending) => {
    for (const rows of [[], [{ name: "ORDER-001" }]]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: rows })));
      for (const filters of [{ [pending]: true }, { delivery_from_date: "2026-06-01" }, { overdue_as_of: "2026-06-30" }]) {
        const result = await invokeTool(tool, { company: "Example Company", ...filters });
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content[0].text)).toEqual(rows);
        expect(result.content[1].text).toContain("Even an empty result");
        expect(result.content[1].text).toContain('"item_delivery_check_complete":false');
        expect(result.structuredContent).toHaveProperty("delivery_scope.item_delivery_check_complete", false);
      }
      const ordinary = await invokeTool(tool, { company: "Example Company", from_date: "2026-06-01", to_date: "2026-06-30" });
      expect(ordinary.content).toHaveLength(1);
      expect(JSON.parse(ordinary.content[0].text)).toEqual(rows);
    }
  });

  it.each(["get_stock_balance", "get_stock_ledger"])("rejects empty stock scopes and mixed date modes for %s", async (tool) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const scope of [{ item_codes: [] }, { warehouses: [] }, { item_codes: [""] }]) {
      const result = await invokeTool(tool, { company: "Example Company", period: "current_fiscal_year", as_of_date: "2026-06-30", ...scope });
      expect(result.isError).toBe(true);
    }
    const mixed = await invokeTool(tool, { company: "Example Company", period: "current_fiscal_year", as_of_date: "2026-06-30", from_date: "2026-04-01", to_date: "2026-06-30" });
    expect(mixed.isError).toBe(true);
    expect(mixed.content[0].text).toContain("INVALID_ARGUMENT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["get_stock_balance", "get_stock_ledger"])("preserves exact item and warehouse scope for %s", async (tool) => {
    const fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      expect(JSON.parse(body.get("filters")!)).toMatchObject({
        company: "Example Company", item_code: ["ITEM-001"], warehouse: ["WH-001"],
        from_date: "2026-06-01", to_date: "2026-06-30",
      });
      return Response.json({ message: { result: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await invokeTool(tool, { company: "Example Company", item_codes: ["ITEM-001"], warehouses: ["WH-001"], from_date: "2026-06-01", to_date: "2026-06-30" });
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

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

  it("adds confirmed overdue through the service route without an extra request or broader filters", async () => {
    const fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      expect(body.get("report_name")).toBe("Accounts Receivable");
      expect(JSON.parse(body.get("filters")!)).toEqual({
        company: "Example Company", report_date: "2026-06-30", party_type: "Customer",
        party: ["CUS-001"], customer_group: ["Wholesale"], cost_center: ["Main"], project: ["PROJ-001"],
        ageing_based_on: "Posting Date", age_as_on: "Report Date", range: "15, 45",
        group_by_party: 1, show_future_payments: 0, show_remarks: 0,
      });
      return Response.json({ message: { result: [
        { party: "CUS-001", voucher_no: "SINV-001", outstanding: 100, due_date: "2026-06-29", range2: 100, currency: "NZD" },
        { party: "CUS-001", voucher_no: "SINV-002", outstanding: 40, due_date: "2026-06-30", range2: 40, currency: "NZD" },
        { party: "CUS-001", bold: 1, outstanding: 140, range2: 140, currency: "NZD" },
        {}, { party: "Total", bold: 1, outstanding: 140, range2: 140, currency: "NZD" },
      ] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await invokeTool("get_accounts_receivable_summary", {
      company: "Example Company", report_date: "2026-06-30", customers: ["CUS-001"],
      customer_groups: ["Wholesale"], cost_centres: ["Main"], projects: ["PROJ-001"],
      ageing_based_on: "Posting Date", ageing_ranges: [15, 45], limit: 1,
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      overdue_complete: true, totals: { overdue: 100, outstanding: 140, ageing: { "16_to_45_days": 140 } },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("supports the customer insight tool sequence with one exact customer and distinct date scopes", async () => {
    const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/Customer")) return Response.json({ data: [
        { name: "CUS-001", customer_name: "Example Retail Ltd", disabled: 0 },
      ] });
      if (url.pathname.includes("/Company/")) return Response.json({ data: { default_currency: "NZD" } });
      if (url.pathname.endsWith("get_fiscal_year")) {
        expect(url.searchParams.get("company")).toBe("Example Company");
        expect(url.searchParams.get("date")).toBe("2026-06-30");
        return Response.json({ message: ["2026-2027", "2026-04-01", "2027-03-31"] });
      }
      if (url.pathname.endsWith("query_report.run")) {
        const body = new URLSearchParams(String(init.body));
        const filters = JSON.parse(body.get("filters")!);
        expect(filters.company).toBe("Example Company");
        if (body.get("report_name") === "Accounts Receivable") {
          expect(filters.party).toEqual(["CUS-001"]);
          expect(filters.report_date).toBe("2026-06-30");
          return Response.json({ message: { result: [
            { party: "CUS-001", voucher_no: "SINV-001", outstanding: 100, due_date: "2026-03-01" },
          ] } });
        }
        expect(body.get("report_name")).toBe("Item-wise Sales Register");
        expect(filters).toEqual({ company: "Example Company", customer: "CUS-001", from_date: "2026-04-01", to_date: "2026-06-30" });
        return Response.json({ message: { result: [
          { invoice: "SINV-002", posting_date: "2026-05-01", amount: 200 },
        ] } });
      }
      expect(decodeURIComponent(url.pathname)).toBe("/api/resource/Sales Invoice");
      const filters = JSON.parse(url.searchParams.get("filters")!);
      expect(filters).toEqual(expect.arrayContaining([
        ["Sales Invoice", "company", "=", "Example Company"],
        ["Sales Invoice", "customer", "=", "CUS-001"],
        ["Sales Invoice", "due_date", "<", "2026-06-30"],
        ["Sales Invoice", "docstatus", "=", 1],
        ["Sales Invoice", "outstanding_amount", ">", 0],
      ]));
      expect(filters.some((filter: unknown[]) => filter[1] === "posting_date")).toBe(false);
      expect(url.searchParams.get("order_by")).toBe("due_date asc");
      return Response.json({ data: [{ name: "SINV-001", customer: "CUS-001", due_date: "2026-03-01", outstanding_amount: 100 }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const balance = await invokeTool("get_party_balance", {
      company: "Example Company", party_type: "Customer", query: "Example Retail Ltd", report_date: "2026-06-30",
    });
    expect(balance.isError).not.toBe(true);
    const party = JSON.parse(balance.content[0].text);
    expect(party).toMatchObject({ status: "matched", party: "CUS-001", totals: { overdue: 100 } });
    const sales = await invokeTool("get_sales_summary", {
      company: "Example Company", customer: party.party, group_by: "month", limit: 12,
      period: "current_fiscal_year", as_of_date: "2026-06-30", from_date: null, to_date: null,
    });
    expect(sales.isError).not.toBe(true);
    expect(JSON.parse(sales.content[0].text)).toMatchObject({ total_net_sales: 200, totals_complete: true });
    const invoices = await invokeTool("list_sales_invoices", {
      company: "Example Company", customer: party.party, overdue_as_of: "2026-06-30",
      sort_by: "due_date", sort_order: "asc", limit: 3,
    });
    expect(invoices.isError).not.toBe(true);
    expect(invoices.content[0].text).toContain("SINV-001");
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
