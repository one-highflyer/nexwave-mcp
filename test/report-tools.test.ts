import { afterEach, describe, expect, it, vi } from "vitest";
import { normaliseAgeingSummary, normaliseReportResult, registerReportTools, validateDateRange } from "../src/report-tools";
import type { NexWaveAuthProps } from "../src/types";

const PROPS: NexWaveAuthProps = {
  authType: "api_token", siteId: "site_test", siteName: "Demo", baseUrl: "https://demo.example.com",
  user: "service@example.com", upstreamApiKey: "api-key", upstreamApiSecret: "api-secret",
};
const COMPANY = "Example Company";
const BANK_ARGS = { company: COMPANY, account: "Bank - EC", report_date: "2026-06-30" };
const GL_ARGS = { company: COMPANY, from_date: "2026-06-01", to_date: "2026-06-30" };
const BANK_ACCOUNT = { company: COMPANY, account_type: "Bank", disabled: 0, is_group: 0 };

function reportHandler(toolName: string) {
  let invoke: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const server = {
    registerTool(name: string, definition: { inputSchema: { parse: (args: unknown) => unknown } }, handler: (args: unknown) => Promise<unknown>) {
      if (name === toolName) invoke = (args) => handler(definition.inputSchema.parse(args));
    },
  };
  registerReportTools(server as never, async () => PROPS);
  if (!invoke) throw new Error(`Tool ${toolName} was not registered.`);
  return invoke;
}

describe("financial report filter validation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { company: "Other Company" }, { account_type: "Receivable" }, { disabled: 1 }, { is_group: 1 },
  ])("rejects an invalid bank reconciliation Account before running the report: %j", async (change) => {
    const fetchMock = vi.fn(async (_input: string) => Response.json({ data: { ...BANK_ACCOUNT, ...change } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reportHandler("get_bank_reconciliation_statement")(BANK_ARGS)).rejects.toThrow("enabled Bank or Cash ledger Account in the selected company");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${PROPS.baseUrl}/api/resource/Account/Bank%20-%20EC`);
  });

  it.each(["Bank", "Cash"])("reads an enabled %s Account with the caller's permission before running reconciliation", async (account_type) => {
    const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => new URL(input).pathname.startsWith("/api/resource/")
      ? Response.json({ data: { ...BANK_ACCOUNT, account_type } })
      : Response.json({ message: { columns: [], result: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    await reportHandler("get_bank_reconciliation_statement")(BANK_ARGS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "token api-key:api-secret" }) });
    const url = new URL(fetchMock.mock.calls[1][0]);
    expect(url.pathname).toBe("/api/method/frappe.desk.query_report.run");
    expect(JSON.parse(new URLSearchParams(String(fetchMock.mock.calls.at(-1)![1]?.body)).get("filters")!)).toMatchObject({ company: COMPANY, account: BANK_ARGS.account, report_date: BANK_ARGS.report_date });
  });

  it.each([
    ["get_bank_reconciliation_statement", BANK_ARGS],
    ["get_general_ledger", { ...GL_ARGS, group_by: "account", accounts: ["Assets - EC"] }],
  ] as const)("stops %s when the caller cannot read the Account", async (tool, args) => {
    const fetchMock = vi.fn(async () => Response.json({ exception: "Private upstream detail" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reportHandler(tool)(args)).rejects.toThrow("PERMISSION_DENIED");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a voucher number with voucher grouping and gives an alternative before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(reportHandler("get_general_ledger")({ ...GL_ARGS, voucher_no: "INV-001", group_by: "voucher" })).rejects.toThrow("Use voucher_consolidated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects leaf Accounts in account grouping even after a valid group Account", async () => {
    const fetchMock = vi.fn(async (input: string) => Response.json({ data: { is_group: input.includes("Assets") ? 1 : 0 } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reportHandler("get_general_ledger")({ ...GL_ARGS, group_by: "account", accounts: ["Assets - EC", "Bank - EC"] })).rejects.toThrow("use voucher_consolidated for a ledger Account");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url.includes("/api/resource/Account/"))).toBe(true);
  });

  it("rejects an Account response without its group status", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reportHandler("get_general_ledger")({ ...GL_ARGS, group_by: "account", accounts: ["Assets - EC"] })).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [{ voucher_no: "INV-001", accounts: ["Bank - EC"] }, "Categorize by Voucher (Consolidated)", 0],
    [{ group_by: "voucher_consolidated", voucher_no: "INV-001" }, "Categorize by Voucher (Consolidated)", 0],
    [{ group_by: "voucher" }, "Categorize by Voucher", 0],
    [{ group_by: "party", voucher_no: "INV-001" }, "Categorize by Party", 0],
    [{ group_by: "account", voucher_no: "INV-001" }, "Categorize by Account", 0],
    [{ group_by: "account", accounts: ["Assets - EC", "Liabilities - EC"] }, "Categorize by Account", 2],
  ])("preserves valid GL grouping: %j", async (args, category, accountReads) => {
    const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => new URL(input).pathname.startsWith("/api/resource/")
      ? Response.json({ data: { is_group: 1 } })
      : Response.json({ message: { columns: [], result: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    await reportHandler("get_general_ledger")({ ...GL_ARGS, ...args });
    expect(fetchMock).toHaveBeenCalledTimes(Number(accountReads) + 1);
    const url = new URL(fetchMock.mock.calls.at(-1)![0]);
    expect(url.pathname).toBe("/api/method/frappe.desk.query_report.run");
    expect(JSON.parse(new URLSearchParams(String(fetchMock.mock.calls.at(-1)![1]?.body)).get("filters")!)).toMatchObject({ categorize_by: category, company: COMPANY });
  });
});

describe("report tool output", () => {
  it("keeps report columns, removes HTML, and truncates rows", () => {
    const result = normaliseReportResult(
      "Profit and Loss Statement",
      { company: "Example Company" },
      {
        columns: [
          { fieldname: "account", label: "<b>Account</b>", fieldtype: "Data" },
          { fieldname: "total", label: "Total", fieldtype: "Currency" },
        ],
        result: [
          { account: "<strong>Income</strong>", total: 100, internal_value: "hidden", indent: 0 },
          { account: "Sales", total: 100, internal_value: "hidden", indent: 1 },
        ],
        report_summary: [{ label: "<b>Net profit</b>", value: 100, datatype: "Currency", extra: "hidden" }],
        execution_time: 0.25,
      },
      1,
    );

    expect(result.columns[0]).toMatchObject({ fieldname: "account", label: "Account" });
    expect(result.rows).toEqual([{ account: "Income", total: 100, indent: 0 }]);
    expect(result.summary).toEqual([{ label: "Net profit", value: 100, datatype: "Currency" }]);
    expect(result.row_count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("rejects invalid and overlong detailed report ranges", () => {
    expect(() => validateDateRange("2026-02-30", "2026-03-01")).toThrow("valid dates");
    expect(() => validateDateRange("2026-03-02", "2026-03-01")).toThrow("on or before");
    expect(() => validateDateRange("2025-01-01", "2026-01-02", 366)).toThrow("maximum date range");
  });

  it("returns a compact receivables summary without double-counting grouped rows", () => {
    const result = normaliseAgeingSummary(
      "Accounts Receivable",
      { company: "Example Company", group_by_party: 1 },
      {
        result: [
          { party: "Example Customer", voucher_no: "INV-001", invoiced: 125, outstanding: 125, range1: 25, range2: 100, currency: "NZD" },
          { party: "Example Customer", bold: 1, invoiced: 125, outstanding: 125, range1: 25, range2: 100, currency: "NZD" },
          { party: null },
          { party: "Another Customer", bold: 1, invoiced: 75, paid: 25, outstanding: 50, range1: 50, currency: "NZD" },
          { party: "Total", bold: 1, invoiced: 200, paid: 25, outstanding: 175, range1: 75, range2: 100, currency: "NZD" },
        ],
        execution_time: 0.2,
      },
      [30, 60, 90, 120],
      1,
    );

    expect(result.totals).toEqual({
      currency: "NZD",
      invoiced: 200,
      paid: 25,
      credit_note: 0,
      outstanding: 175,
      ageing: {
        "0_to_30_days": 75,
        "31_to_60_days": 100,
        "61_to_90_days": 0,
        "91_to_120_days": 0,
        "over_120_days": 0,
      },
    });
    expect(result.top_customers).toEqual([{
      customer: "Example Customer",
      currency: "NZD",
      outstanding: 125,
      ageing: {
        "0_to_30_days": 25,
        "31_to_60_days": 100,
        "61_to_90_days": 0,
        "91_to_120_days": 0,
        "over_120_days": 0,
      },
    }]);
    expect(result.customer_count).toBe(2);
    expect(result.invoice_count).toBe(1);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result).indexOf('"totals"')).toBeLessThan(JSON.stringify(result).indexOf('"filters"'));
  });

  it("keeps a customer named Total while excluding only the final report total", () => {
    const result = normaliseAgeingSummary(
      "Accounts Receivable",
      { company: "Example Company", group_by_party: 1 },
      {
        result: [
          { party: "Total", voucher_no: "INV-002", outstanding: 50, range1: 50, currency: "NZD" },
          { party: "Total", bold: 1, outstanding: 50, range1: 50, currency: "NZD" },
          { party: null },
          { party: "Total", bold: 1, outstanding: 50, range1: 50, currency: "NZD" },
        ],
      },
      [30, 60, 90, 120],
      10,
    );

    expect(result.customer_count).toBe(1);
    expect(result.top_customers[0]).toMatchObject({ customer: "Total", outstanding: 50 });
    expect(result.totals.outstanding).toBe(50);
  });

  it.each([
    { result: [{ unexpected: "payload" }] },
    { result: [{ party: "C-001", voucher_no: "INV-001", outstanding: "100" }] },
    { result: [{ party: "C-001", voucher_no: "INV-001", outstanding: 100, range1: "100" }] },
    { result: [{}] },
  ])("rejects malformed receivable rows instead of asserting zero", (data) => {
    expect(() => normaliseAgeingSummary("Accounts Receivable", {}, data, [30, 60, 90, 120], 5)).toThrow("UPSTREAM_INVALID_RESPONSE");
  });

  it("separates document credits within the same customer without double-counting subtotals", () => {
    const result = normaliseAgeingSummary("Accounts Receivable", {}, { result: [
      { party: "C-001", voucher_no: "INV-001", outstanding: 100 },
      { party: "C-001", voucher_no: "PAY-001", outstanding: -25 },
      { party: "C-001", bold: 1, outstanding: 75 },
      {},
      { party: "Total", bold: 1, outstanding: 75 },
    ] }, [30, 60, 90, 120], 5);
    expect(result).toMatchObject({ credit_breakdown_complete: true, totals: { outstanding: 75, positive_outstanding: 100, credit_balance: 25 } });
  });

  it("does not invent a credit breakdown from incomplete detail rows", () => {
    const result = normaliseAgeingSummary("Accounts Receivable", {}, { result: [
      { party: "C-001", voucher_no: "INV-001", outstanding: 100 },
      { party: "C-001", bold: 1, outstanding: 75 },
      { party: "Total", bold: 1, outstanding: 75 },
    ] }, [30, 60, 90, 120], 5);
    expect(result.credit_breakdown_complete).toBe(false);
    expect(result.totals.outstanding).toBe(75);
    expect(result.totals).not.toHaveProperty("positive_outstanding");
    expect(result.totals).not.toHaveProperty("credit_balance");
  });

  it("calculates overdue from document dates, not ageing buckets or displayed customer limits", () => {
    const result = normaliseAgeingSummary("Accounts Receivable", {
      report_date: "2026-06-30", ageing_based_on: "Posting Date", group_by_party: 1,
    }, { result: [
      { party: "C-001", voucher_no: "INV-001", outstanding: 100, due_date: "2026-06-29", range1: 100 },
      { party: "C-001", voucher_no: "INV-002", outstanding: 40, due_date: "2026-06-01", range1: 40 },
      { party: "C-001", voucher_no: "INV-003", outstanding: 30, due_date: "2026-06-30", range2: 30 },
      { party: "C-001", voucher_no: "INV-004", outstanding: 20, due_date: "2026-07-01", range2: 20 },
      { party: "C-001", voucher_no: "PAY-001", outstanding: -25 },
      { party: "C-001", bold: 1, outstanding: 165, range1: 140, range2: 50 },
      {},
      { party: "C-002", voucher_no: "INV-005", outstanding: 50, due_date: "2026-04-01", range3: 50 },
      { party: "C-002", bold: 1, outstanding: 50, range3: 50 },
      {},
      { party: "Total", bold: 1, outstanding: 215, range1: 140, range2: 50, range3: 50 },
    ] }, [30, 60, 90, 120], 1);

    expect(result).toMatchObject({ overdue_complete: true, truncated: true,
      totals: { outstanding: 215, positive_outstanding: 240, credit_balance: 25, overdue: 190 },
    });
    expect(result.overdue_basis).toContain("before allocation of unallocated credits");
    expect(result.top_customers).toHaveLength(1);
  });

  it.each([undefined, null, "", "   "])("uses posting date only when due date is absent or blank (%s)", (dueDate) => {
    const result = normaliseAgeingSummary("Accounts Receivable", { report_date: "2026-06-30" }, {
      result: [{ party: "C-001", voucher_no: "JE-001", outstanding: 12.34, due_date: dueDate, posting_date: "2026-06-29" }],
    }, [30, 60, 90, 120], 5);
    expect(result).toMatchObject({ overdue_complete: true, totals: { overdue: 12.34 } });
  });

  it.each([
    { due_date: undefined, posting_date: undefined },
    { due_date: "invalid", posting_date: "2026-06-01" },
    { due_date: "2026-02-30", posting_date: "2026-06-01" },
    { due_date: 20260601, posting_date: "2026-06-01" },
  ])("does not assert overdue when a positive document has an unknown date: %j", (dates) => {
    const result = normaliseAgeingSummary("Accounts Receivable", { report_date: "2026-06-30" }, {
      result: [{ party: "C-001", voucher_no: "INV-001", outstanding: 100, ...dates }],
    }, [30, 60, 90, 120], 5);
    expect(result.overdue_complete).toBe(false);
    expect(result.totals.outstanding).toBe(100);
    expect(result.totals).not.toHaveProperty("overdue");
  });

  it.each([
    [{ party: "C-001", bold: 1, outstanding: 0 }],
    [
      { party: "C-001", voucher_no: "INV-001", outstanding: 100, due_date: "2026-06-01" },
      { party: "C-001", bold: 1, outstanding: 100 },
      { party: "C-002", bold: 1, outstanding: 0 },
    ],
    [
      { party: "C-001", voucher_no: "INV-001", outstanding: 100, due_date: "2026-06-01" },
      { party: "C-001", bold: 1, outstanding: 75 },
      { party: "C-002", voucher_no: "INV-002", outstanding: 100, due_date: "2026-06-01" },
      { party: "C-002", bold: 1, outstanding: 125 },
    ],
  ])("does not infer overdue from incomplete per-customer details %#", (...rows) => {
    const result = normaliseAgeingSummary("Accounts Receivable", { report_date: "2026-06-30" }, {
      result: rows,
    }, [30, 60, 90, 120], 5);
    expect(result.overdue_complete).toBe(false);
    expect(result.totals).not.toHaveProperty("overdue");
  });

  it("confirms zero overdue for a completed empty report", () => {
    const result = normaliseAgeingSummary("Accounts Receivable", { report_date: "2026-06-30" }, {
      result: [],
    }, [30, 60, 90, 120], 5);
    expect(result).toMatchObject({ overdue_complete: true, totals: { overdue: 0 } });
  });

  it("keeps a customer named Total in the overdue calculation", () => {
    const result = normaliseAgeingSummary("Accounts Receivable", { report_date: "2026-06-30" }, { result: [
      { party: "Total", voucher_no: "INV-001", outstanding: 100, due_date: "2026-06-29" },
      { party: "Total", bold: 1, outstanding: 100 }, {},
      { party: "Total", bold: 1, outstanding: 100 },
    ] }, [30, 60, 90, 120], 5);
    expect(result).toMatchObject({ overdue_complete: true, totals: { overdue: 100 }, customer_count: 1 });
  });
});


it("continues report pages without losing a total row at the end", () => {
  const report = { columns: [{ fieldname: "account", label: "Account" }], result: [{ account: "A" }, { account: "B" }, { account: "Total", is_total_row: true }] };
  const first = normaliseReportResult("Trial Balance", {}, report, 2);
  expect(first).toMatchObject({ row_count: 3, next_offset: 2, complete: false });
  expect(first.warning).toContain("one report page");
  const last = normaliseReportResult("Trial Balance", {}, report, 2, 2);
  expect(last.rows).toEqual([{ account: "Total", is_total_row: true }]);
  expect(last).toMatchObject({ next_offset: null, truncated: false, complete: false });
  expect(normaliseReportResult("Trial Balance", {}, report, 2, 10)).toMatchObject({ rows: [], next_offset: null, complete: false });
});


it("discloses column and summary clipping even when all rows fit", () => {
  const result = normaliseReportResult("Profit and Loss Statement", {}, {
    columns: Array.from({ length: 101 }, (_, i) => ({ fieldname: `field_${i}`, label: `Field ${i}` })),
    result: [], report_summary: Array.from({ length: 21 }, () => ({ label: "Value", value: 1 })),
  }, 100);
  expect(result.complete).toBe(false);
  expect(result.warning).toContain("columns");
  expect(result.warning).toContain("summary");
});
