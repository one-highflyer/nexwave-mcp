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

    for (const name of [
      "list_companies",
      "list_customers",
      "list_items",
      "list_suppliers",
      "list_warehouses",
      "list_accounts",
      "list_cost_centres",
      "list_projects",
      "list_fiscal_years",
      "list_sales_invoices",
      "list_purchase_invoices",
      "list_payments",
      "list_bank_transactions",
      "list_sales_orders",
      "get_document",
      "get_stock_balance",
      "get_stock_ledger",
      "get_profit_and_loss",
      "get_trial_balance",
      "get_general_ledger",
      "get_accounts_receivable_summary",
      "get_accounts_receivable",
      "get_accounts_payable",
      "get_bank_reconciliation_statement",
    ]) {
      expect(findNullableSchemaNodes(server.toolInputSchemaJson(name)), name).toEqual([]);
    }
  });
});

function findNullableSchemaNodes(value: unknown, path = "schema"): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findNullableSchemaNodes(item, `${path}[${index}]`));
  }

  const record = value as Record<string, unknown>;
  return [
    ...(record.type === "null" || Array.isArray(record.type) ? [path] : []),
    ...Object.entries(record).flatMap(([key, child]) => findNullableSchemaNodes(child, `${path}.${key}`)),
  ];
}
