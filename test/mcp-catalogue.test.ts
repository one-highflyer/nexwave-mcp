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

  it("publishes standard optional schemas for model providers", () => {
    const server = createNexWaveServer();
    const companies = server.toolInputSchemaJson("list_companies") as {
      properties?: Record<string, Record<string, unknown>>;
    };
    const invoices = server.toolInputSchemaJson("list_sales_invoices") as {
      properties?: Record<string, Record<string, unknown>>;
    };

    expect(companies.properties?.limit?.type).toBe("integer");
    expect(invoices.properties?.search?.type).toBe("string");
    expect(invoices.properties?.to_date?.type).toBe("string");
  });
});
