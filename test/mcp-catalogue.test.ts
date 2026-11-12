import { describe, expect, it } from "vitest";
import { createNexWaveServer } from "../src/mcp";

type InputSchema = {
  properties: Record<string, InputSchema>;
  required?: string[];
  items?: InputSchema;
  anyOf?: InputSchema[];
  const?: unknown;
  default?: unknown;
  additionalProperties?: boolean;
};

describe("MCP tool catalogue", () => {
  it("publishes required Sales Order header and line dates for creates and new update rows", () => {
    const server = createNexWaveServer();
    const create = server.toolInputSchemaJson("create_draft_sales_order") as InputSchema;
    const update = server.toolInputSchemaJson("update_draft_sales_order") as InputSchema;
    expect(create.required).toContain("delivery_date");
    expect(create.properties.items.items?.required).toEqual(expect.arrayContaining(["item_code", "qty", "delivery_date"]));
    expect(update.required).toEqual(expect.arrayContaining(["request_key", "name", "expected_modified"]));
    expect(update.required).not.toContain("delivery_date");
    expect(update.required).not.toContain("items");
    const branches = update.properties.items.items?.anyOf ?? [];
    expect(branches).toHaveLength(2);
    const existing = branches.find((branch) => branch.required?.includes("name"));
    const added = branches.find((branch) => branch.properties.new_item?.const === true);
    expect(existing?.required).toEqual(expect.arrayContaining(["name", "item_code", "qty"]));
    expect(existing?.required).not.toContain("delivery_date");
    expect(added?.required).toEqual(expect.arrayContaining(["new_item", "item_code", "qty", "delivery_date"]));
    expect(existing?.additionalProperties).toBe(false);
    expect(added?.additionalProperties).toBe(false);
  });

  it.each([
    ["create_draft_quotation", ["request_key", "company", "quotation_to", "party_name", "items"], ["transaction_date", "selling_price_list", "currency"]],
    ["create_draft_sales_order", ["request_key", "company", "customer", "items", "delivery_date"], ["transaction_date", "selling_price_list", "currency"]],
    ["create_draft_purchase_invoice", ["request_key", "company", "supplier", "items"], ["posting_date", "due_date", "buying_price_list", "currency"]],
    ["create_customer", ["request_key", "customer_name"], ["customer_type", "customer_group", "territory"]],
    ["create_lead", ["request_key", "first_name"], ["company_name", "territory", "source"]],
  ])("keeps required business inputs and optional native defaults clear for %s", (name, required, optional) => {
    const schema = createNexWaveServer().toolInputSchemaJson(name) as InputSchema;
    expect(schema.required).toEqual(expect.arrayContaining(required));
    for (const field of optional) {
      expect(schema.properties, field).toHaveProperty(field);
      expect(schema.required, field).not.toContain(field);
    }
    expect(schema.additionalProperties).toBe(false);
    for (const field of ["naming_series", "status", "conversion_rate", "price_list_currency", "plc_conversion_rate", "credit_to"]) {
      expect(schema.properties, field).not.toHaveProperty(field);
    }
    if (schema.properties.items) {
      const item = schema.properties.items.items!;
      expect(item.required).toEqual(expect.arrayContaining(["item_code", "qty"]));
      expect(item.required).not.toContain("uom");
      expect(item.required).not.toContain("rate");
      for (const field of ["item_name", "conversion_factor", "stock_qty", "amount", "base_rate", "base_amount"]) {
        expect(item.properties, field).not.toHaveProperty(field);
      }
    }
    if (name === "create_customer") expect(schema.properties.customer_type.default).toBe("Company");
  });

  it("requires an explicit confirmation and restricts document submission types", () => {
    const schema = createNexWaveServer().toolInputSchemaJson("submit_document") as {
      properties: Record<string, { enum?: string[]; const?: boolean }>;
      required: string[]; additionalProperties: boolean;
    };
    expect(schema.properties.doctype.enum).toEqual(["Quotation", "Sales Order", "Purchase Invoice"]);
    expect(schema.properties.confirm_submission.const).toBe(true);
    expect(schema.required).toEqual(expect.arrayContaining(["doctype", "name", "expected_modified", "request_key", "confirm_submission"]));
    expect(schema.additionalProperties).toBe(false);
  });

  it("registers order, invoice, payment, bank transaction, and bank reconciliation tools", () => {
    const server = createNexWaveServer();

    for (const name of [
      "list_sales_invoices",
      "list_purchase_invoices",
      "list_purchase_orders",
      "list_payments",
      "list_bank_transactions",
      "get_bank_reconciliation_statement",
      "get_party_balance",
      "get_accounts_payable_summary",
      "get_sales_summary",
      "get_stock_risk",
      "create_draft_sales_order",
      "update_draft_sales_order",
      "create_draft_purchase_invoice",
      "update_draft_purchase_invoice",
      "list_prospects",
      "submit_document",
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
      "list_purchase_orders",
      "list_payments",
      "list_bank_transactions",
      "list_sales_orders",
      "list_work_orders",
      "list_boms",
      "list_job_cards",
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
      "get_party_balance",
      "get_accounts_payable_summary",
      "get_sales_summary",
      "get_stock_risk",
      "create_draft_sales_order",
      "update_draft_sales_order",
      "create_draft_purchase_invoice",
      "update_draft_purchase_invoice",
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
