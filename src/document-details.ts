import { ToolError } from "./tool-result";

const ITEM_FIELDS = ["name", "idx", "item_code", "item_name", "description", "qty", "uom", "stock_qty", "stock_uom", "conversion_factor", "rate", "amount", "base_rate", "base_amount", "net_rate", "net_amount", "warehouse", "delivery_date", "schedule_date", "received_qty", "delivered_qty", "sales_order", "sales_order_item", "purchase_order", "purchase_order_item", "delivery_note", "purchase_receipt"];
const REFERENCE_FIELDS = ["name", "idx", "reference_doctype", "reference_name", "due_date", "total_amount", "outstanding_amount", "allocated_amount", "exchange_rate", "account"];
const TABLES: Record<string, Record<string, string[]>> = {
  "Sales Order": { items: ITEM_FIELDS }, "Purchase Order": { items: ITEM_FIELDS },
  "Sales Invoice": { items: ITEM_FIELDS }, "Purchase Invoice": { items: ITEM_FIELDS },
  "Payment Entry": { references: REFERENCE_FIELDS },
  "Bank Transaction": { payment_entries: ["name", "idx", "payment_document", "payment_entry", "allocated_amount"] },
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
