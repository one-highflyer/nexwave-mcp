import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { documentDetails } from "./document-details";
import { assertDirectSubmissionAllowed, frappeGet, frappeSubmitDocument } from "./frappe";
import { sha256 } from "./security";
import { registerWriteTool } from "./tool-contract";
import { structuredResult, ToolError } from "./tool-result";
import { SUBMITTABLE_DOCTYPES, type Env, type NexWaveAuthProps, type SubmittableDoctype, type WriteCapability } from "./types";
import { requireWriteAccess } from "./write-access";

const ID = z.string().trim().min(1).max(140);
const INPUT = z.strictObject({
  doctype: z.enum(SUBMITTABLE_DOCTYPES), name: ID,
  expected_modified: z.string().min(1).max(40).describe("Exact modified value from the reviewed get_document result. Changed documents must be reviewed again."),
  request_key: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).describe("Unique request key. Reuse this key and identical arguments after a lost response. Do not retry an uncertain submission with a new key."),
  confirm_submission: z.literal(true).describe("Set true only after the user explicitly approves submission of this exact document and its reviewed totals and links."),
});
const CAPABILITIES: Record<SubmittableDoctype, WriteCapability> = {
  Quotation: "quotations", "Sales Order": "sales_orders", "Purchase Invoice": "purchase_invoices",
};
const FIELDS = ["name", "modified", "docstatus", "status", "company", "quotation_to", "party_name", "customer", "customer_name", "supplier", "supplier_name", "transaction_date", "posting_date", "delivery_date", "due_date", "currency", "order_type", "total", "net_total", "total_taxes_and_charges", "grand_total", "rounded_total", "apply_discount_on", "additional_discount_percentage", "discount_amount", "taxes_and_charges", "payment_terms_template", "tc_name", "is_return", "update_stock", "is_paid", "paid_amount"];

export function registerSubmissionWrite(server: McpServer, currentProps: () => Promise<NexWaveAuthProps>, env?: Env) {
  registerWriteTool(server, "submit_document", {
    description: "Submit one reviewed draft Quotation, Sales Order or ordinary unpaid Purchase Invoice without stock updates or returns. Requires explicit user approval, submissions access and the corresponding document write capability. Uses native submit permissions and validation and can create accounting entries or other native effects. Active approval workflows must be completed in NexWave. Never edits items or source links, cancels, emails or retries an uncertain submission.",
    inputSchema: INPUT,
  }, async (raw) => {
    try { return await executeSubmission(env, await currentProps(), raw); }
    catch (error) {
      if (error instanceof ToolError) throw error;
      throw uncertain();
    }
  });
}

export async function executeSubmission(env: Env | undefined, props: NexWaveAuthProps, raw: unknown) {
  const parsed = INPUT.safeParse(raw);
  if (!parsed.success) throw new ToolError("INVALID_ARGUMENT", "Supply an allowed document type, exact name, reviewed modified timestamp, request key and confirm_submission:true.");
  const input = parsed.data;
  const trustedEnv = await requireWriteAccess(env, props, "submissions");
  await requireWriteAccess(env, props, CAPABILITIES[input.doctype]);
  const fingerprint = await sha256(canonical(input));
  const bindings = [props.siteId, props.user, "submit_document", input.request_key];
  const previous = await trustedEnv.NEXWAVE_MCP_DB.prepare("SELECT fingerprint, state, document_name FROM write_requests WHERE site_id = ? AND user_id = ? AND operation = ? AND request_key = ?")
    .bind(...bindings).first<{ fingerprint: string; state: string; document_name: string | null }>();
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new ToolError("CONFLICT", "This request key was already used with different arguments.");
    if (previous.state !== "complete" || previous.document_name !== input.name) throw uncertain();
    const current = await frappeGet<Record<string, unknown>>(props, input.doctype, input.name);
    assertIdentity(current, input.doctype, input.name);
    return result(input.doctype, current, true);
  }
  const current = await frappeGet<Record<string, unknown>>(props, input.doctype, input.name);
  assertIdentity(current, input.doctype, input.name);
  if (current.docstatus !== 0) throw new ToolError("INVALID_ARGUMENT", "Only draft documents can be submitted. Read the current document before taking another action.");
  if (typeof current.modified !== "string") throw new ToolError("UPSTREAM_INVALID_RESPONSE", "The document modification timestamp was not returned.");
  if (current.modified !== input.expected_modified) throw new ToolError("CONFLICT", "The document changed. Read it again and obtain approval for the current version before submission.");
  if (input.doctype === "Purchase Invoice" && ["is_return", "update_stock", "is_paid", "paid_amount"].some((key) => current[key] !== 0)) {
    throw new ToolError("INVALID_ARGUMENT", "Use an ordinary unpaid Purchase Invoice without stock updates or returns. These settings must be visible to confirm submission eligibility.");
  }
  await assertDirectSubmissionAllowed(props, input.doctype);
  const reservation = await trustedEnv.NEXWAVE_MCP_DB.prepare("INSERT INTO write_requests (site_id, user_id, operation, request_key, fingerprint) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(...bindings, fingerprint).run();
  if (reservation.meta.changes !== 1) throw uncertain();
  try {
    const saved = await frappeSubmitDocument(props, input.doctype, input.name, input.expected_modified);
    const completed = await trustedEnv.NEXWAVE_MCP_DB.prepare("UPDATE write_requests SET state = 'complete', document_name = ? WHERE site_id = ? AND user_id = ? AND operation = ? AND request_key = ?")
      .bind(saved.name, ...bindings).run();
    if (completed.meta.changes !== 1) throw uncertain();
    return result(input.doctype, saved, false);
  } catch (error) {
    try {
      await trustedEnv.NEXWAVE_MCP_DB.prepare("UPDATE write_requests SET state = 'unknown' WHERE site_id = ? AND user_id = ? AND operation = ? AND request_key = ?")
        .bind(...bindings).run();
    } catch { /* Keep a pending reservation if D1 is unavailable; never submit again automatically. */ }
    if (error instanceof ToolError && ["PERMISSION_DENIED", "AUTHENTICATION_REQUIRED", "VALIDATION_FAILED", "NOT_FOUND"].includes(error.code)) throw error;
    throw uncertain();
  }
}

function assertIdentity(document: Record<string, unknown>, doctype: SubmittableDoctype, name: string) {
  if (document.doctype !== doctype || document.name !== name) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned an unexpected document.");
}
function result(doctype: SubmittableDoctype, document: Record<string, unknown>, replayed: boolean) {
  const fields = Object.fromEntries(FIELDS.filter((field) => document[field] === null || ["string", "number", "boolean"].includes(typeof document[field])).map((field) => [field, document[field]]));
  return structuredResult({ doctype, name: document.name, replayed, document: { ...fields, ...documentDetails(doctype, document, 0, 50) },
    note: replayed ? "This request was already completed. The document shown is its current permission-visible state." : "Submitted in NexWave. Review the saved status, totals and source links." });
}
function uncertain() {
  return new ToolError("WRITE_OUTCOME_UNKNOWN", "Submission could not be confirmed. Read the document and ask the administrator to reconcile this request key. Do not retry with a new key.");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
