import { describe, expect, it } from "vitest";
import { summariseSales, summariseStockRisk } from "../src/insight-tools";

describe("business summaries", () => {
  it("groups all sales before limiting and excludes the report total row", () => {
    const result = summariseSales({ result: [
      { invoice: "INV-001", customer: "C-001", customer_name: "Example One", amount: 100 },
      { invoice: "INV-002", customer: "C-001", customer_name: "Example One", amount: -20 },
      { invoice: "INV-003", customer: "C-002", customer_name: "Example Two", amount: 50 },
      { customer: "Total", amount: 130 },
    ] }, "customer", 1);
    expect(result.total_net_sales).toBe(130);
    expect(result.groups).toEqual([{ name: "C-001", label: "Example One", net_sales: 80 }]);
    expect(result).toMatchObject({ truncated: true, totals_complete: true, line_count: 3 });
  });

  it("groups months by posting date and refuses invalid amounts", () => {
    expect(summariseSales({ result: [
      { invoice: "INV-001", posting_date: "2026-09-01", amount: 25 },
      { invoice: "INV-002", posting_date: "2026-09-20", amount: 50 },
    ] }, "month", 5).groups).toEqual([{ name: "2026-09", label: "2026-09", net_sales: 75 }]);
    expect(() => summariseSales({ result: [{ invoice: "INV-001", customer: "C-001", amount: "100" }] }, "customer", 5)).toThrow("UPSTREAM_INVALID_RESPONSE");
  });

  it("reports unknown thresholds separately from actual stock risk", () => {
    const common = { warehouse: "Stores", stock_uom: "Nos", actual_qty: 2, projected_qty: 3, re_order_qty: 0, re_order_level: 0 };
    const data = { result: [
      { ...common, item_code: "I-001" },
      { ...common, item_code: "I-002", re_order_level: 5 },
      { ...common, item_code: "I-003", re_order_level: 2 },
    ] };
    const result = summariseStockRisk(data, 5);
    expect(result).toMatchObject({ checked_rows: 3, missing_threshold_rows: 1, risk_count: 1 });
    expect(result.rows[0]).toMatchObject({ item_code: "I-002", shortage_qty: 2 });
    expect(summariseStockRisk(data, 1, 4)).toMatchObject({ risk_count: 3, missing_threshold_rows: 0, truncated: true });
  });
});
