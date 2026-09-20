import { describe, expect, it } from "vitest";
import { createNexWaveServer } from "../src/mcp";

describe("MCP tool catalogue", () => {
  it("registers invoice, payment, bank transaction, and bank reconciliation tools", () => {
    const server = createNexWaveServer();

    for (const name of [
      "list_sales_invoices",
      "list_purchase_invoices",
      "list_payments",
      "list_bank_transactions",
      "get_bank_reconciliation_statement",
    ]) {
      expect(server.toolInputSchemaJson(name), name).toBeDefined();
    }
  });
});
