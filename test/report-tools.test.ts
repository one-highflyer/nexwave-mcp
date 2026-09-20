import { describe, expect, it } from "vitest";
import { normaliseReportResult, validateDateRange } from "../src/report-tools";

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
});
