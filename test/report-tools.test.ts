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
});
