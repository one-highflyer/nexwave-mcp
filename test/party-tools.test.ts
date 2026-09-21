import { describe, expect, it } from "vitest";
import { summarisePartyBalances } from "../src/party-tools";

describe("party balances", () => {
  it("keeps credits and positive balances separate, excludes totals, and treats today as not overdue", () => {
    const result = summarisePartyBalances({ result: [
      { party: "SUP-001", voucher_no: "INV-001", outstanding: 100, due_date: "2026-09-01" },
      { party: "SUP-001", voucher_no: "INV-002", outstanding: 20, due_date: "2026-09-21" },
      { party: "SUP-001", voucher_no: "PAY-001", outstanding: -30 },
      { party: "SUP-002", voucher_no: "INV-003", outstanding: 200, due_date: "2026-10-01" },
      { party: "Total", outstanding: 290 },
    ] }, "NZD", "2026-09-21", 1);
    expect(result.totals).toEqual({ outstanding: 290, positive_outstanding: 320, credit_balance: 30, overdue: 100 });
    expect(result.truncated).toBe(true);
    expect(result.totals_complete).toBe(true);
    expect(result.overdue_complete).toBe(true);
    expect(result.top_parties[0].party).toBe("SUP-002");
  });

  it("does not report a zero balance when a report format is unknown", () => {
    expect(() => summarisePartyBalances({ result: [{ unrelated: 100 }] }, "NZD", "2026-09-21", 5)).toThrow("UPSTREAM_INVALID_RESPONSE");
    expect(() => summarisePartyBalances({ result: [{ party: "SUP-001", voucher_no: "INV-001", outstanding: "100" }] }, "NZD", "2026-09-21", 5)).toThrow("UPSTREAM_INVALID_RESPONSE");
    expect(summarisePartyBalances({ result: [] }, "NZD", "2026-09-21", 5).totals.outstanding).toBe(0);
  });

  it.each([
    {},
    { due_date: "2026-02-30", posting_date: "2026-06-01" },
    { due_date: "not-a-date", posting_date: "2026-06-01" },
  ])("withholds overdue but preserves balance totals when a document date is unknown: %j", (dates) => {
    const result = summarisePartyBalances({ result: [
      { party: "CUS-001", voucher_no: "INV-001", outstanding: 100, ...dates },
      { party: "CUS-001", voucher_no: "INV-002", outstanding: 20, due_date: "2026-06-01" },
    ] }, "NZD", "2026-06-30", 5);
    expect(result).toMatchObject({ totals_complete: true, overdue_complete: false, totals: { outstanding: 120 } });
    expect(result.totals).not.toHaveProperty("overdue");
    expect(result.top_parties[0]).not.toHaveProperty("overdue");
  });

  it("uses posting dates for positive entries without a due date and keeps credits separate", () => {
    const result = summarisePartyBalances({ result: [
      { party: "SUP-001", voucher_no: "JE-001", outstanding: 100, posting_date: "2026-06-01" },
      { party: "SUP-001", voucher_no: "PAY-001", outstanding: -30 },
    ] }, "NZD", "2026-06-30", 5);
    expect(result).toMatchObject({ overdue_complete: true, totals: { outstanding: 70, overdue: 100, credit_balance: 30 } });
  });
});
