import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { documentDetails } from "./document-details";
import { frappeGet, frappeMapDraft, frappeWrite } from "./frappe";
import { sha256 } from "./security";
import { registerWriteTool } from "./tool-contract";
import { structuredResult, ToolError } from "./tool-result";
import type { Env, NexWaveAuthProps } from "./types";
import { requireWriteAccess } from "./write-access";

const ID = z.string().trim().min(1).max(140);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v, "Use a valid date.");
const KEY = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).describe("Unique request key. Reuse this key and identical arguments after a lost response. Never use a new key to retry an uncertain write.");
const ITEM = {
  item_code: ID, qty: z.number().positive().max(1e9), uom: ID.optional(),
  rate: z.number().nonnegative().max(1e12).optional().describe("Explicit rate. On create, omit to use the source rate or NexWave pricing. On an existing update row, omission retains the saved rate."), description: z.string().max(10000).optional(),
  warehouse: ID.optional(), discount_percentage: z.number().min(0).max(100).optional(),
};
const SO_ITEM = { ...ITEM, delivery_date: DATE.optional(), prevdoc_docname: ID.optional().describe("Exact submitted Customer Quotation ID; requires quotation_item."), quotation_item: ID.optional().describe("Exact source item row name, not its item code or row number.") };
const PI_ITEM = { ...ITEM, expense_account: ID.optional(), cost_center: ID.optional(), purchase_order: ID.optional().describe("Exact submitted Purchase Order ID; requires po_detail."), po_detail: ID.optional().describe("Exact source item row name, not its item code or row number.") };
const COMMON = { currency: ID.optional(), taxes_and_charges: ID.optional(), payment_terms_template: ID.optional(), tc_name: ID.optional() };
const SO_FIELDS = { ...COMMON, transaction_date: DATE.optional(), delivery_date: DATE.optional(), selling_price_list: ID.optional() };
const PI_FIELDS = { ...COMMON, posting_date: DATE.optional(), due_date: DATE.optional(), bill_no: ID.optional(), bill_date: DATE.optional(), buying_price_list: ID.optional() };
function updateItem(fields: typeof SO_ITEM | typeof PI_ITEM) {
  return z.strictObject({ ...fields, name: ID.optional(), new_item: z.literal(true).optional() }).refine((r) => Boolean(r.name) !== Boolean(r.new_item), "Supply name for each existing row, or new_item:true for an explicitly new row.");
}
const ITEMS_NOTE = "Full desired item list. Every retained existing row requires its exact name from get_document; omit source fields to preserve links. New rows require new_item:true. Omitted existing rows are removed.";
const SCHEMAS = {
  create_draft_sales_order: z.strictObject({ request_key: KEY, company: ID, customer: ID, ...SO_FIELDS, items: z.array(z.strictObject(SO_ITEM)).min(1).max(50) }),
  update_draft_sales_order: z.strictObject({ request_key: KEY, name: ID, expected_modified: ID, ...SO_FIELDS, items: z.array(updateItem(SO_ITEM)).min(1).max(50).optional().describe(ITEMS_NOTE) }),
  create_draft_purchase_invoice: z.strictObject({ request_key: KEY, company: ID, supplier: ID, ...PI_FIELDS, items: z.array(z.strictObject(PI_ITEM)).min(1).max(50) }),
  update_draft_purchase_invoice: z.strictObject({ request_key: KEY, name: ID, expected_modified: ID, ...PI_FIELDS, items: z.array(updateItem(PI_ITEM)).min(1).max(50).optional().describe(ITEMS_NOTE) }),
};
type Operation = keyof typeof SCHEMAS;
type Row = Record<string, unknown>;
type Target = "Sales Order" | "Purchase Invoice";
const LINKS = ["prevdoc_docname", "quotation_item", "purchase_order", "po_detail", "purchase_receipt", "pr_detail", "material_request", "material_request_item", "sales_order", "sales_order_item", "purchase_order_item"];
const MAPPED_ITEM_FIELDS = [...Object.keys(ITEM), "conversion_factor", "price_list_rate", "discount_amount", "delivery_date", "expense_account", "cost_center", "project", "item_tax_template", ...LINKS];
const MAPPED_HEADERS = ["order_type", "currency", "conversion_rate", "selling_price_list", "buying_price_list", "price_list_currency", "plc_conversion_rate", "taxes_and_charges", "payment_terms_template", "tc_name", "terms", "customer_address", "address_display", "supplier_address", "shipping_address_name", "shipping_address", "contact_person", "contact_display", "contact_email", "contact_mobile", "credit_to", "ignore_pricing_rule"];
const TAX_FIELDS = ["charge_type", "row_id", "account_head", "description", "included_in_print_rate", "included_in_paid_amount", "cost_center", "rate", "tax_amount", "account_currency", "add_deduct_tax", "category"];

export function registerTransactionWrites(server: McpServer, currentProps: () => Promise<NexWaveAuthProps>, env?: Env) {
  for (const name of Object.keys(SCHEMAS) as Operation[]) {
    const target = name.includes("sales_order") ? "Sales Order" : "Purchase Invoice";
    registerWriteTool(server, name, {
      description: `${name.startsWith("create_") ? "Create" : "Update"} one draft ${target}. Optional item source links use exact document and child row IDs and native ERPNext conversion. Sources must be submitted, open and match company, party and currency; quotations must address a Customer. Up to 50 items and 5 source documents. Updates require expected_modified and retain source links on named rows. Purchase Invoices are ordinary unpaid drafts without stock updates. Drafts do not reserve source quantities. Review saved totals before submission.`,
      inputSchema: SCHEMAS[name],
    }, async (input) => executeTransactionWrite(env, await currentProps(), name, input));
  }
}

export async function executeTransactionWrite(env: Env | undefined, props: NexWaveAuthProps, operation: Operation, raw: unknown) {
  const parsed = SCHEMAS[operation].safeParse(raw);
  if (!parsed.success) throw invalid("Check required fields, valid dates, and item row names. New update rows require new_item:true.");
  const input = parsed.data as Row & { request_key: string };
  const target: Target = operation.includes("sales_order") ? "Sales Order" : "Purchase Invoice";
  const sales = target === "Sales Order";
  const trustedEnv = await requireWriteAccess(env, props, sales ? "sales_orders" : "purchase_invoices");
  const bindings = [props.siteId, props.user, operation, input.request_key];
  const fingerprint = await sha256(canonical(input));
  const prior = await trustedEnv.NEXWAVE_MCP_DB.prepare("SELECT fingerprint, state, document_name FROM write_requests WHERE site_id = ? AND user_id = ? AND operation = ? AND request_key = ?")
    .bind(...bindings).first<{ fingerprint: string; state: string; document_name: string | null }>();
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new ToolError("CONFLICT", "This request key was already used with different arguments.");
    if (prior.state !== "complete" || !prior.document_name) throw uncertain();
    return result(target, await frappeGet<Row>(props, target, prior.document_name), true);
  }
  const { request_key: _key, name: _name, expected_modified: _modified, ...values } = input;
  let current: Row | undefined;
  if (operation.startsWith("update_")) {
    current = await frappeGet<Row>(props, target, String(input.name));
    if (current.docstatus !== 0) throw invalid("Only draft documents can be changed.");
    if (current.modified !== input.expected_modified) throw new ToolError("CONFLICT", "The document changed. Read it again before making this change.");
    if (!Object.keys(values).length) throw invalid("Supply at least one field to change.");
    if (!sales && (current.is_return || current.update_stock || current.is_paid)) throw invalid("Use an ordinary unpaid Purchase Invoice draft without stock updates or returns.");
  } else {
    await frappeGet(props, sales ? "Customer" : "Supplier", String(values[sales ? "customer" : "supplier"]));
  }
  const patch: Row = { ...values };
  if (current) patch.modified = current.modified;
  const priceFields = sales ? ["currency", "selling_price_list", "transaction_date"] : ["currency", "buying_price_list", "posting_date"];
  if (current && priceFields.some((f) => values[f] !== undefined && values[f] !== current![f])) {
    if (!values.items) throw invalid("Supply the full items array when changing the price list, currency or document date.");
    patch.conversion_rate = 0; patch.plc_conversion_rate = 0; patch.price_list_currency = "";
  }
  if (current && ["payment_terms_template", sales ? "transaction_date" : "posting_date"].some((f) => values[f] !== undefined && values[f] !== current![f])) patch.payment_schedule = [];
  const effective = { ...current, ...patch };
  if (!sales && effective.due_date && effective.posting_date && String(effective.due_date) < String(effective.posting_date)) throw invalid("Due date must not be before the posting date.");
  if (!sales && values.posting_date) patch.set_posting_time = 1;
  if (sales && effective.delivery_date && effective.transaction_date && String(effective.delivery_date) < String(effective.transaction_date)) throw invalid("Delivery date must not be before the order date.");
  const rows = values.items ? mergeRows(values.items as Row[], current) : current ? documentRows(current) : [];
  const parentField = sales ? "prevdoc_docname" : "purchase_order";
  const rowField = sales ? "quotation_item" : "po_detail";
  const sources = new Map<string, { document: Row; rows: Set<string> }>();
  for (const row of rows) {
    if (Boolean(row[parentField]) !== Boolean(row[rowField])) throw invalid("Supply both the source document and its exact item row ID.");
    if (!row[parentField]) continue;
    const sourceName = String(row[parentField]);
    if (!sources.has(sourceName)) {
      if (sources.size === 5) throw invalid("Use at most five source documents in one draft.");
      const source = await frappeGet<Row>(props, sales ? "Quotation" : "Purchase Order", sourceName);
      if (source.name !== sourceName || source.docstatus !== 1 || ["Closed", "On Hold", "Cancelled", "Lost"].includes(String(source.status))) throw invalid("Use a submitted, open source document.");
      if (source.company !== effective.company) throw invalid("Source documents must use the target company.");
      if (sales ? source.quotation_to !== "Customer" || source.party_name !== effective.customer : source.supplier !== effective.supplier) throw invalid("Source documents must use the target Customer or Supplier. Linked quotations must address a Customer.");
      if (sales && ((current && (source.order_type ?? "Sales") !== (current.order_type ?? "Sales"))
        || (sources.size && (source.order_type ?? "Sales") !== (sources.values().next().value!.document.order_type ?? "Sales")))) throw invalid("Source quotations must use the same order type as each other and the existing Sales Order.");
      if (effective.currency && source.currency !== effective.currency) throw invalid("Source and target document currencies must match.");
      if (sources.size && source.currency !== sources.values().next().value!.document.currency) throw invalid("All source documents must use the same currency.");
      sources.set(sourceName, { document: source, rows: new Set() });
    }
    const source = sources.get(sourceName)!;
    const sourceRow = documentRows(source.document).find((r) => r.name === row[rowField]);
    if (!sourceRow || sourceRow.item_code !== row.item_code || (row.uom && row.uom !== sourceRow.uom)) throw invalid("The source row must belong to that document and match the item and UOM.");
    source.rows.add(String(row[rowField]));
  }
  if (values.taxes_and_charges) {
    const template = await frappeGet<Row>(props, sales ? "Sales Taxes and Charges Template" : "Purchase Taxes and Charges Template", String(values.taxes_and_charges));
    if (template.company !== effective.company || template.disabled) throw invalid("Use an enabled tax template for this company.");
    patch.taxes = documentRows(template, "taxes").map((r) => select(r, TAX_FIELDS));
    if (!(patch.taxes as Row[]).length || (patch.taxes as Row[]).length > 50) throw invalid("Use a tax template with one to fifty tax rows.");
  }
  if (values.payment_terms_template) await frappeGet(props, "Payment Terms Template", String(values.payment_terms_template));
  if (values.tc_name) {
    const terms = await frappeGet<Row>(props, "Terms and Conditions", String(values.tc_name));
    if (terms.disabled || !terms[sales ? "selling" : "buying"] || typeof terms.terms !== "string" || terms.terms.length > 100000) throw invalid("Use an enabled terms template for this transaction type.");
    patch.terms = "";
  }
  const reservation = await trustedEnv.NEXWAVE_MCP_DB.prepare("INSERT INTO write_requests (site_id, user_id, operation, request_key, fingerprint) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(...bindings, fingerprint).run();
  if (reservation.meta.changes !== 1) throw uncertain();
  try {
    const mappedRows = new Map<string, Row>();
    let sourceHeaders: Row = {};
    let taxSignature: string | undefined;
    for (const [sourceName, source] of sources) {
      const mapped = await frappeMapDraft(props, target, sourceName, [...source.rows]);
      if (mapped.company !== effective.company || mapped[sales ? "customer" : "supplier"] !== effective[sales ? "customer" : "supplier"] || mapped.currency !== source.document.currency) throw invalid("The converted draft does not match the target company, party and currency.");
      if (sales && (mapped.order_type ?? "Sales") !== (source.document.order_type ?? "Sales")) throw invalid("The converted draft does not match the source quotation order type.");
      const taxes = documentRows(mapped, "taxes").map((r) => select(r, TAX_FIELDS));
      const signature = canonical(taxes.map((row) => {
        const { tax_amount, ...settings } = row;
        return row.charge_type === "Actual" ? row : settings;
      }));
      if (!current && !values.taxes_and_charges && taxSignature !== undefined && signature !== taxSignature) throw invalid("Source tax rows differ. Select a common tax template explicitly.");
      if (!taxSignature) {
        sourceHeaders = { ...select(mapped, MAPPED_HEADERS), taxes };
        taxSignature = signature;
      }
      for (const r of documentRows(mapped)) {
        if (r[parentField] === sourceName && source.rows.has(String(r[rowField]))) mappedRows.set(`${sourceName}\0${r[rowField]}`, r);
      }
    }
    const quantities = new Map<string, number>();
    const savedRows = rows.map((row) => {
      if (!row[parentField]) return row;
      const key = `${row[parentField]}\0${row[rowField]}`;
      const mapped = mappedRows.get(key);
      if (!mapped || mapped.item_code !== row.item_code || (row.uom && mapped.uom !== row.uom) || !Number.isFinite(Number(mapped.qty))) throw invalid("This source row has no matching available quantity.");
      const qty = (quantities.get(key) ?? 0) + Number(row.qty);
      quantities.set(key, qty);
      if (qty > Number(mapped.qty) + 1e-9) throw invalid("Requested quantity exceeds the available source quantity.");
      return row.name ? row : { ...select(mapped, MAPPED_ITEM_FIELDS), ...row };
    });
    // Native mapping supplies trusted defaults. Client input cannot pass arbitrary document fields.
    const document: Row = { ...(!current ? sourceHeaders : {}), ...patch };
    if (!current && sources.size && priceFields.some((f) => values[f] !== undefined && values[f] !== sourceHeaders[f])) {
      document.conversion_rate = 0; document.plc_conversion_rate = 0; document.price_list_currency = "";
    }
    if (values.items) document.items = savedRows;
    if (!current && sales && !document.order_type) document.order_type = "Sales";
    if (!sales) document.update_stock = 0;
    const saved = await frappeWrite(props, target, document, current ? String(input.name) : undefined);
    verifySavedLinks(saved, savedRows);
    await trustedEnv.NEXWAVE_MCP_DB.prepare("UPDATE write_requests SET state = 'complete', document_name = ? WHERE site_id = ? AND user_id = ? AND operation = ? AND request_key = ?")
      .bind(saved.name, ...bindings).run();
    return result(target, saved, false);
  } catch (error) {
    try {
      await trustedEnv.NEXWAVE_MCP_DB.prepare("UPDATE write_requests SET state = 'unknown' WHERE site_id = ? AND user_id = ? AND operation = ? AND request_key = ?")
        .bind(...bindings).run();
    } catch { throw uncertain(); }
    if (error instanceof ToolError && ["INVALID_ARGUMENT", "PERMISSION_DENIED", "AUTHENTICATION_REQUIRED", "VALIDATION_FAILED", "NOT_FOUND"].includes(error.code)) throw error;
    throw uncertain();
  }
}

function mergeRows(requested: Row[], current?: Row): Row[] {
  const existing = current ? documentRows(current) : [];
  const names = new Set<string>();
  return requested.map(({ new_item: _new, ...row }) => {
    if (!row.name) return row;
    const name = String(row.name);
    const prior = existing.find((r) => r.name === name);
    if (!prior || names.has(name)) throw invalid("Use each existing item row name once, from this draft only.");
    names.add(name);
    for (const field of LINKS) if (field in row && row[field] !== prior[field]) throw invalid("Existing source links cannot be changed. Add an explicitly new row to use another source.");
    // Changing identity while merging hidden defaults could keep the previous item's accounts
    // or UOM conversion. Replacement must be an explicit new row with fresh server defaults.
    if (row.item_code !== prior.item_code || (row.uom && row.uom !== prior.uom)) throw invalid("The item and UOM of an existing row cannot be changed. Replace it with an explicitly new row.");
    return { ...prior, ...row };
  });
}
function documentRows(doc: Row, table = "items"): Row[] {
  const rows = doc[table];
  if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === "object" && !Array.isArray(r))) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave did not return readable document rows.");
  return rows as Row[];
}
function verifySavedLinks(saved: Row, planned: Row[]) {
  const rows = documentRows(saved);
  for (let i = 0; i < planned.length; i++) {
    const before = planned[i];
    const after = before.name ? rows.find((r) => r.name === before.name) : rows[i];
    if (!after || LINKS.some((f) => before[f] && before[f] !== after[f])) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The saved source links could not be confirmed.");
  }
}
const RESULT_FIELDS = ["name", "modified", "docstatus", "status", "company", "customer", "customer_name", "supplier", "supplier_name", "order_type", "transaction_date", "delivery_date", "posting_date", "due_date", "bill_no", "bill_date", "currency", "selling_price_list", "buying_price_list", "taxes_and_charges", "payment_terms_template", "tc_name", "conversion_rate", "total", "net_total", "grand_total", "total_taxes_and_charges", "rounded_total", "update_stock"];
function result(doctype: Target, saved: Row, replayed: boolean) {
  return structuredResult({ doctype, name: saved.name, replayed, document: { ...select(saved, RESULT_FIELDS), ...documentDetails(doctype, saved, 0, 50) }, note: replayed ? "This request was already completed. The document shown is its current permission-visible state." : "Draft saved. Review its source links, prices, taxes and totals. Drafts do not reserve source quantities." });
}
function select(row: Row, fields: readonly string[]): Row {
  return Object.fromEntries(fields.filter((f) => row[f] === null || ["string", "number", "boolean"].includes(typeof row[f])).map((f) => [f, row[f]]));
}
function invalid(message: string) { return new ToolError("INVALID_ARGUMENT", message); }
function uncertain() { return new ToolError("WRITE_OUTCOME_UNKNOWN", "This request is pending or its result cannot be confirmed. Check NexWave and ask the administrator to reconcile this request key. Do not retry with a new key."); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
