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
    expect(result.top_parties[0].party).toBe("SUP-002");
  });

  it("does not report a zero balance when a report format is unknown", () => {
    expect(() => summarisePartyBalances({ result: [{ unrelated: 100 }] }, "NZD", "2026-09-21", 5)).toThrow("UPSTREAM_INVALID_RESPONSE");
    expect(() => summarisePartyBalances({ result: [{ party: "SUP-001", voucher_no: "INV-001", outstanding: "100" }] }, "NZD", "2026-09-21", 5)).toThrow("UPSTREAM_INVALID_RESPONSE");
    expect(summarisePartyBalances({ result: [] }, "NZD", "2026-09-21", 5).totals.outstanding).toBe(0);
  });
});
