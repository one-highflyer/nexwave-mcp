import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { frappeAddressDisplay, frappeGet, frappeList, frappeWrite } from "./frappe";
import { registerWriteTool } from "./tool-contract";
import { structuredResult, ToolError } from "./tool-result";
import { sha256 } from "./security";
import { requireWriteAccess } from "./write-access";
import type { Env, NexWaveAuthProps, WriteCapability } from "./types";
import { documentDetails } from "./document-details";

const ID = z.string().trim().min(1).max(140);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, "Use a valid date.");
const KEY = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).describe("Unique request key. Reuse this key and identical arguments after a lost response. Never use a new key to retry an uncertain write.");
const ITEM = z.strictObject({
  item_code: ID, qty: z.number().positive().max(1e9), uom: ID.optional(),
  rate: z.number().nonnegative().max(1e12).optional().describe("Explicit offered rate. Omit to let NexWave fetch pricing. The saved result is authoritative."),
  description: z.string().max(10000).optional(), warehouse: ID.optional(),
  discount_percentage: z.number().min(0).max(100).optional(),
});
const QUOTE_FIELDS = {
  transaction_date: DATE.optional(), valid_till: DATE.optional(),
  selling_price_list: ID.optional(), currency: ID.optional(),
  taxes_and_charges: ID.optional().describe("Exact enabled Sales Taxes and Charges Template for the quotation company."),
  payment_terms_template: ID.optional(), tc_name: ID.optional(),
  customer_address: ID.optional(), shipping_address_name: ID.optional(), contact_person: ID.optional(),
  items: z.array(ITEM).min(1).max(50),
};
const CREATE_QUOTE = z.strictObject({
  request_key: KEY, company: ID, quotation_to: z.enum(["Customer", "Lead"]), party_name: ID,
  ...QUOTE_FIELDS,
});
const UPDATE_QUOTE = z.strictObject({
  request_key: KEY, name: ID, expected_modified: z.string().min(1).max(40).describe("Exact modified value from get_document. Prevents overwriting another user's changes."),
  ...QUOTE_FIELDS, items: QUOTE_FIELDS.items.optional(),
});
const CREATE_LEAD = z.strictObject({
  request_key: KEY, first_name: z.string().trim().min(1).max(140), last_name: z.string().trim().max(140).optional(),
  company_name: ID.optional(), email_id: z.email().max(254).optional(), mobile_no: z.string().trim().min(1).max(40).optional(),
  territory: ID.optional(), source: ID.optional(), industry: ID.optional(),
});
const CREATE_CUSTOMER = z.strictObject({
  request_key: KEY, customer_name: ID, customer_type: z.enum(["Company", "Individual", "Partnership"]).default("Company"),
  customer_group: ID.optional(), territory: ID.optional(),
  default_currency: ID.optional(), default_price_list: ID.optional(), payment_terms: ID.optional(),
  email_id: z.email().max(254).optional(), mobile_no: z.string().trim().min(1).max(40).optional(),
  first_name: ID.optional(), last_name: ID.optional(),
});

export function registerQuotationWrites(server: McpServer, currentProps: () => Promise<NexWaveAuthProps>, env?: Env) {
  const tools = [
    ["create_draft_quotation", "Create one draft quotation addressed to an existing Customer or Lead. Omitted rates use NexWave pricing; returns saved totals. Never submits or sends email.", CREATE_QUOTE],
    ["update_draft_quotation", "Update one draft quotation using expected_modified. Supplying items replaces all item rows. For price list, currency or transaction-date changes, supply the full items array to recalculate rates. Never submits or sends email.", UPDATE_QUOTE],
    ["create_lead", "Create one Lead after checking list_leads for duplicates. Quotes may be addressed to Leads without creating Customers.", CREATE_LEAD],
    ["create_customer", "Create one Customer after checking list_customers for duplicates. Optional email/mobile/name fields use NexWave's normal primary Contact creation and permissions. Does not create addresses.", CREATE_CUSTOMER],
  ] as const;
  for (const [name, description, schema] of tools) {
    registerWriteTool(server, name, { description, inputSchema: schema }, async (input) => {
      const props = await currentProps();
      try { return await executeWrite(env, props, name, input); }
      catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("WRITE_OUTCOME_UNKNOWN", "The write could not be confirmed. Check NexWave and the request key before another attempt.");
      }
    });
  }
}

type WriteOperation = "create_draft_quotation" | "update_draft_quotation" | "create_lead" | "create_customer";

export async function executeWrite(env: Env | undefined, props: NexWaveAuthProps, operation: WriteOperation, raw: unknown) {
  const schema = { create_draft_quotation: CREATE_QUOTE, update_draft_quotation: UPDATE_QUOTE, create_lead: CREATE_LEAD, create_customer: CREATE_CUSTOMER }[operation];
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ToolError("INVALID_ARGUMENT", "The write arguments are invalid. Check the tool schema and required fields.");
  const input = parsed.data as Record<string, unknown> & { request_key: string };
  const capability: WriteCapability = operation.includes("quotation") ? "quotations" : operation === "create_lead" ? "leads" : "customers";
  const trustedEnv = await requireWriteAccess(env, props, capability);
  const doctype = capability === "quotations" ? "Quotation" : capability === "leads" ? "Lead" : "Customer";
  const fingerprint = await sha256(canonical(input));
  const bindings = [props.siteId, props.user, operation, input.request_key];
  const previous = await trustedEnv.NEXWAVE_MCP_DB.prepare("SELECT fingerprint, state, document_name FROM write_requests WHERE site_id = ? AND user_id = ? AND operation = ? AND request_key = ?")
    .bind(...bindings).first<{ fingerprint: string; state: string; document_name: string | null }>();
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new ToolError("CONFLICT", "This request key was already used with different arguments. Use the original arguments or a new key for a separate action.");
    if (previous.state !== "complete" || !previous.document_name) throw uncertain();
    const document = await frappeGet<Record<string, unknown>>(props, doctype, previous.document_name);
    return writeResult(doctype, document, true);
  }

  const { request_key: _key, expected_modified: _expected, name: _name, ...values } = input;
  let patch: Record<string, unknown> = { ...values };
  let existingName: string | undefined;
  if (operation === "update_draft_quotation") {
    existingName = String(input.name);
    const current = await frappeGet<Record<string, unknown>>(props, "Quotation", existingName);
    if (current.docstatus !== 0) throw new ToolError("INVALID_ARGUMENT", "Only draft quotations can be changed.");
    if (current.modified !== input.expected_modified) throw new ToolError("CONFLICT", "The quotation changed. Read it again before making this change.");
    if (!Object.keys(values).length) throw new ToolError("INVALID_ARGUMENT", "Supply at least one quotation field to change.");
    if (["selling_price_list", "currency", "transaction_date"].some((field) => field in values && values[field] !== current[field]) && !values.items) {
      throw new ToolError("INVALID_ARGUMENT", "Supply all items when changing the price list, currency or transaction date so pricing can be recalculated.");
    }
    if (["selling_price_list", "currency", "transaction_date"].some((field) => field in values && values[field] !== current[field])) {
      patch.conversion_rate = 0;
      patch.plc_conversion_rate = 0;
      patch.price_list_currency = "";
    }
    if ((values.payment_terms_template && values.payment_terms_template !== current.payment_terms_template)
      || (values.transaction_date && values.transaction_date !== current.transaction_date)) patch.payment_schedule = [];
    patch.modified = current.modified;
    if (values.valid_till && String(values.valid_till) < String(values.transaction_date ?? current.transaction_date)) throw new ToolError("INVALID_ARGUMENT", "Valid till must not be before the quotation date.");
    if (values.taxes_and_charges) patch.taxes = await templateRows(props, String(values.taxes_and_charges), String(current.company));
    if (values.tc_name) patch.terms = await templateTerms(props, String(values.tc_name));
  } else if (doctype === "Quotation") {
    if (values.valid_till && values.transaction_date && String(values.valid_till) < String(values.transaction_date)) throw new ToolError("INVALID_ARGUMENT", "Valid till must not be before the quotation date.");
    await frappeGet(props, String(values.quotation_to), String(values.party_name));
    if (values.taxes_and_charges) patch.taxes = await templateRows(props, String(values.taxes_and_charges), String(values.company));
    if (values.tc_name) patch.terms = await templateTerms(props, String(values.tc_name));
  } else {
    const fields = doctype === "Lead" ? ["email_id", "first_name", "last_name", "company_name"] : ["customer_name"];
    const duplicateField = doctype === "Lead" && values.email_id ? "email_id" : doctype === "Customer" ? "customer_name" : "first_name";
    const filters: unknown[] = [[doctype, duplicateField, "=", values[duplicateField]]];
    if (doctype === "Lead" && duplicateField === "first_name") {
      filters.push([doctype, "last_name", "=", values.last_name ?? ""]);
      if (values.company_name) filters.push([doctype, "company_name", "=", values.company_name]);
    }
    const orFilters = doctype === "Customer" && values.email_id ? [[doctype, "customer_name", "=", values.customer_name], [doctype, "email_id", "=", values.email_id]] : [];
    const matches = await frappeList<Record<string, unknown>>(props, doctype, ["name", ...fields], { filters: orFilters.length ? [] : filters, orFilters, limit: 1 });
    if (matches.length) throw new ToolError("CONFLICT", "A matching party already exists. Use the list tool to confirm its record ID before creating another.");
  }
  // A selected payment template must be readable before Frappe copies its schedule.
  if (values.payment_terms_template) await frappeGet(props, "Payment Terms Template", String(values.payment_terms_template));
  if (doctype === "Quotation") await hydrateSelectedPartyLinks(props, patch, values);
  if (Array.isArray(patch.items)) patch.items = patch.items.map((row) => ({ ...(row as Record<string, unknown>) }));
  const reservation = await trustedEnv.NEXWAVE_MCP_DB.prepare("INSERT INTO write_requests (site_id, user_id, operation, request_key, fingerprint) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(...bindings, fingerprint).run();
  if (reservation.meta.changes !== 1) throw uncertain();
  try {
    const saved = await frappeWrite(props, doctype, patch, existingName);
    await trustedEnv.NEXWAVE_MCP_DB.prepare("UPDATE write_requests SET state = 'complete', document_name = ? WHERE site_id = ? AND user_id = ? AND operation = ? AND request_key = ?")
      .bind(saved.name, ...bindings).run();
    return writeResult(doctype, saved, false);
  } catch (error) {
    await trustedEnv.NEXWAVE_MCP_DB.prepare("UPDATE write_requests SET state = 'unknown' WHERE site_id = ? AND user_id = ? AND operation = ? AND request_key = ?")
      .bind(...bindings).run();
    if (error instanceof ToolError && ["PERMISSION_DENIED", "AUTHENTICATION_REQUIRED", "VALIDATION_FAILED", "NOT_FOUND"].includes(error.code)) throw error;
    throw uncertain();
  }
}

const TAX_FIELDS = ["charge_type", "row_id", "account_head", "description", "included_in_print_rate", "included_in_paid_amount", "cost_center", "rate", "tax_amount", "account_currency", "add_deduct_tax", "category"];
async function hydrateSelectedPartyLinks(props: NexWaveAuthProps, patch: Record<string, unknown>, values: Record<string, unknown>) {
  if (values.contact_person) {
    const contact = await frappeGet<Record<string, unknown>>(props, "Contact", String(values.contact_person));
    if (contact.name !== values.contact_person) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned an unexpected Contact.");
    // Server defaults select the party's default Contact, so supply the explicitly selected
    // Contact's copied fields. Empty strings stop missing fields borrowing another person's data.
    for (const [target, source] of [["contact_display", "full_name"], ["contact_email", "email_id"], ["contact_mobile", "mobile_no"]] as const) {
      const value = contact[source];
      if (value !== undefined && value !== null && typeof value !== "string") throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned invalid Contact details.");
      patch[target] = value ?? "";
    }
  }
  // Lead save defaults ignore supplied address links. Native formatting by exact address
  // name also refreshes existing Customer displays without accepting client HTML or methods.
  if (values.customer_address) patch.address_display = await frappeAddressDisplay(props, String(values.customer_address));
  if (values.shipping_address_name) patch.shipping_address = await frappeAddressDisplay(props, String(values.shipping_address_name));
}
async function templateRows(props: NexWaveAuthProps, name: string, company: string) {
  const template = await frappeGet<Record<string, unknown>>(props, "Sales Taxes and Charges Template", name);
  if (template.company !== company || template.disabled || !Array.isArray(template.taxes) || !template.taxes.length) {
    throw new ToolError("INVALID_ARGUMENT", "Use an enabled sales tax template for the quotation company with tax rows.");
  }
  if (template.taxes.length > 50) throw new ToolError("RESULT_TOO_LARGE", "The tax template has too many rows.");
  return template.taxes.map((row) => selectRecord(row, TAX_FIELDS));
}
async function templateTerms(props: NexWaveAuthProps, name: string) {
  const template = await frappeGet<Record<string, unknown>>(props, "Terms and Conditions", name);
  if (template.disabled || template.selling === 0 || typeof template.terms !== "string" || template.terms.length > 100000) throw new ToolError("INVALID_ARGUMENT", "Use an enabled selling Terms and Conditions template.");
  // Frappe renders the selected template with the document context before print.
  return "";
}
const DOCUMENT_FIELDS = ["name", "modified", "docstatus", "status", "company", "quotation_to", "party_name", "customer_name", "customer_type", "customer_group", "territory", "first_name", "last_name", "company_name", "email_id", "mobile_no", "transaction_date", "valid_till", "selling_price_list", "currency", "conversion_rate", "net_total", "total", "total_taxes_and_charges", "grand_total", "rounded_total", "discount_amount", "taxes_and_charges", "payment_terms_template", "tc_name", "contact_person", "contact_display", "contact_email", "contact_mobile", "customer_address", "address_display", "shipping_address_name", "shipping_address"];
function writeResult(doctype: string, value: Record<string, unknown>, replayed: boolean) {
  const document = selectRecord(value, DOCUMENT_FIELDS);
  Object.assign(document, documentDetails(doctype, value, 0, 50));
  return structuredResult({ doctype, name: value.name, replayed, document,
    note: replayed ? "This request was already completed. The document shown is its current permission-visible state." : "Saved in NexWave. Review the saved prices, taxes and totals before sharing." });
}
function selectRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned invalid document details.");
  const row = value as Record<string, unknown>;
  return Object.fromEntries(fields.filter((field) => row[field] === null || ["string", "number", "boolean"].includes(typeof row[field])).map((field) => [field, row[field]]));
}
function uncertain() {
  return new ToolError("WRITE_OUTCOME_UNKNOWN", "This request is pending or its result cannot be confirmed. Check NexWave and ask the administrator to reconcile this request key. Do not retry with a new key.");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
