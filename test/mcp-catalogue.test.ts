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

  it("publishes nullable arguments in a Retell-compatible JSON Schema form", () => {
    const server = createNexWaveServer();

    expectNullableAnyOf(server.toolInputSchemaJson("list_companies"), "limit");
    expectNullableAnyOf(server.toolInputSchemaJson("list_sales_invoices"), "search");
    expectNullableAnyOf(server.toolInputSchemaJson("list_sales_invoices"), "to_date");
    expectNullableAnyOf(server.toolInputSchemaJson("get_profit_and_loss"), "periodicity");

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
      "get_stock_balance",
      "get_stock_ledger",
      "get_profit_and_loss",
      "get_trial_balance",
      "get_general_ledger",
      "get_accounts_receivable",
      "get_accounts_payable",
      "get_bank_reconciliation_statement",
    ]) {
      expect(findArrayTypes(server.toolInputSchemaJson(name)), name).toEqual([]);
    }
  });
});

function expectNullableAnyOf(schema: Record<string, unknown> | undefined, propertyName: string): void {
  const properties = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  const property = properties?.[propertyName];
  expect(property, propertyName).toBeDefined();
  expect(property?.anyOf, propertyName).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "null" })]),
  );
}

function findArrayTypes(value: unknown, path = "schema"): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findArrayTypes(item, `${path}[${index}]`));
  }

  const record = value as Record<string, unknown>;
  return [
    ...(Array.isArray(record.type) ? [`${path}.type`] : []),
    ...Object.entries(record).flatMap(([key, child]) => findArrayTypes(child, `${path}.${key}`)),
  ];
}
