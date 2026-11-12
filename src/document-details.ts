import { ToolError } from "./tool-result";

const ITEM_FIELDS = ["name", "idx", "item_code", "item_name", "description", "qty", "uom", "stock_qty", "stock_uom", "conversion_factor", "rate", "amount", "base_rate", "base_amount", "net_rate", "net_amount", "warehouse", "delivery_date", "schedule_date", "received_qty", "delivered_qty", "sales_order", "sales_order_item", "purchase_order", "purchase_order_item", "delivery_note", "purchase_receipt"];
const REFERENCE_FIELDS = ["name", "idx", "reference_doctype", "reference_name", "due_date", "total_amount", "outstanding_amount", "allocated_amount", "exchange_rate", "account"];
const TABLES: Record<string, Record<string, string[]>> = {
  Prospect: { leads: ["name", "idx", "lead", "lead_name", "status", "email", "mobile_no"] },
  Quotation: {
    items: ITEM_FIELDS.concat(["price_list_rate", "discount_percentage", "discount_amount", "item_tax_template"]),
    taxes: ["name", "idx", "charge_type", "row_id", "account_head", "description", "included_in_print_rate", "rate", "tax_amount", "total", "cost_center"],
    payment_schedule: ["payment_term", "description", "due_date", "invoice_portion", "payment_amount"],
  },
  "Sales Taxes and Charges Template": { taxes: ["charge_type", "row_id", "account_head", "description", "included_in_print_rate", "rate", "tax_amount", "cost_center"] },
  "Purchase Taxes and Charges Template": { taxes: ["charge_type", "row_id", "account_head", "description", "included_in_print_rate", "rate", "tax_amount", "cost_center", "category", "add_deduct_tax"] },
  "Payment Terms Template": { terms: ["payment_term", "description", "invoice_portion", "due_date_based_on", "credit_days", "credit_months", "discount_type", "discount", "discount_validity_based_on", "discount_validity"] },
  "Sales Order": { items: ITEM_FIELDS.concat(["prevdoc_docname", "quotation_item"]) }, "Purchase Order": { items: ITEM_FIELDS },
  "Sales Invoice": { items: ITEM_FIELDS }, "Purchase Invoice": { items: ITEM_FIELDS.concat(["po_detail", "pr_detail"]) },
  "Payment Entry": { references: REFERENCE_FIELDS },
  "Bank Transaction": { payment_entries: ["name", "idx", "payment_document", "payment_entry", "allocated_amount"] },
  "Work Order": {
    required_items: ["name", "idx", "item_code", "item_name", "operation", "source_warehouse", "stock_uom", "required_qty", "transferred_qty", "consumed_qty"],
    operations: ["name", "idx", "operation", "workstation", "sequence_id", "status", "completed_qty", "planned_start_time", "planned_end_time", "actual_start_time", "actual_end_time"],
  },
  BOM: {
    items: ["name", "idx", "item_code", "item_name", "bom_no", "operation", "qty", "uom", "stock_qty", "stock_uom"],
    operations: ["name", "idx", "operation", "workstation", "sequence_id", "time_in_mins", "batch_size"],
  },
  "Job Card": {
    items: ["name", "idx", "item_code", "item_name", "source_warehouse", "required_qty", "transferred_qty", "uom", "stock_uom"],
    sub_operations: ["name", "idx", "sub_operation", "status", "completed_qty"],
  },
};

export function documentDetails(doctype: string, document: Record<string, unknown>, offset: number, limit: number): Record<string, unknown> & { detail_meta: Record<string, unknown> } {
  const details: Record<string, unknown> = {};
  const meta: Record<string, unknown> = {};
  for (const [table, fields] of Object.entries(TABLES[doctype] ?? {})) {
    const rows = document[table];
    if (rows === undefined) {
      meta[table] = { complete: false, warning: "This table was not returned by NexWave. Its contents cannot be confirmed." };
      continue;
    }
    if (!Array.isArray(rows) || !rows.every((row) => row && typeof row === "object" && !Array.isArray(row))) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned an invalid document detail table.");
    details[table] = rows.slice(offset, offset + limit).map((row: Record<string, unknown>) => Object.fromEntries(fields.filter((field) => field in row && (row[field] === null || ["string", "number", "boolean"].includes(typeof row[field]))).map((field) => [field, row[field]])));
    meta[table] = { offset, limit, count: rows.length, next_offset: offset + limit < rows.length ? offset + limit : null, complete: offset === 0 && rows.length > 0 && rows.length <= limit,
      warning: rows.length === 0 ? "No detail rows were returned. The table may be empty or hidden by field permissions; completeness cannot be confirmed." : offset + limit < rows.length ? "Only one detail page is shown. Repeat with detail_offset set to next_offset and the same detail_limit." : offset > 0 ? "This is the final detail page. Combine it with earlier pages to obtain all returned rows." : null };
  }
  return { ...details, detail_meta: meta };
}
