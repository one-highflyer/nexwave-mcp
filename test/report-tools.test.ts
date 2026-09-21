import { describe, expect, it } from "vitest";
import { normaliseAgeingSummary, normaliseReportResult, validateDateRange } from "../src/report-tools";

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
