import { z } from "zod";
import { validateDateRange } from "./report-tools";
import { ToolError } from "./tool-result";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format.");

// Keep each list aligned with its standard DocType, not the other transaction types.
export const SALES_INVOICE_STATUS = statusSchema(["Draft", "Return", "Credit Note Issued", "Submitted", "Paid", "Partly Paid", "Unpaid", "Unpaid and Discounted", "Partly Paid and Discounted", "Overdue and Discounted", "Overdue", "Cancelled", "Internal Transfer"]);
export const PURCHASE_INVOICE_STATUS = statusSchema(["Draft", "Return", "Debit Note Issued", "Submitted", "Paid", "Partly Paid", "Unpaid", "Overdue", "Cancelled", "Internal Transfer"]);
export const SALES_ORDER_STATUS = statusSchema(["Draft", "On Hold", "To Deliver and Bill", "To Bill", "To Deliver", "Completed", "Cancelled", "Closed"]);
export const PURCHASE_ORDER_STATUS = statusSchema(["Draft", "On Hold", "To Receive and Bill", "To Bill", "To Receive", "Completed", "Cancelled", "Closed", "Delivered"]);

export function statusSchema(values: [string, ...string[]]) {
  return z.enum(["All", ...values]).optional().describe("Exact status from this document type. Use All or omit for no status filter, including unpaid, overdue or pending fulfilment queries. Where docstatus is available, use docstatus=1 and status All to select all submitted documents across their operational statuses.");
}

export const DOCSTATUS = z.number().int().min(0).max(2).optional().describe("Document state: 0 draft, 1 submitted, 2 cancelled. For all submitted documents use 1 and status All. Unpaid, overdue and pending fulfilment filters already require submitted documents.");

export const ORDER_DATES = {
  from_date: DATE.optional().describe("Order creation date (transaction_date), not expected delivery date. Inclusive lower bound."),
  to_date: DATE.optional().describe("Order creation date (transaction_date), not expected delivery date. Inclusive upper bound."),
  delivery_from_date: DATE.optional().describe("Order-header schedule date inclusive lower bound: earliest item schedule_date for purchase orders, latest item delivery_date for sales orders. Not a check of remaining item delivery dates."),
  delivery_to_date: DATE.optional().describe("Order-header schedule date inclusive upper bound, not order creation date. Use with delivery_from_date for order-level scheduling examples; this cannot establish all item deliveries in a period."),
  overdue_as_of: DATE.optional().describe("Pending orders with header schedule date strictly before this date. Not an item-level overdue check. Use status All or omit; do not set pending_receipt/pending_delivery to false."),
};

export function dateFilters(doctype: string, field: string, fromDate: unknown, toDate: unknown): unknown[] {
  const from = typeof fromDate === "string" ? fromDate : undefined;
  const to = typeof toDate === "string" ? toDate : undefined;
  const start = from ?? to;
  const end = to ?? from;
  if (start && end) validateDateRange(start, end);
  return [
    ...(from ? [[doctype, field, ">=", from]] : []),
    ...(to ? [[doctype, field, "<=", to]] : []),
  ];
}

export function documentStateFilters(doctype: string, input: Record<string, unknown>): unknown[] {
  if (input.docstatus === undefined) return [];
  const status = input.status;
  if (status && status !== "All") {
    const expected = status === "Draft" ? 0 : status === "Cancelled" ? 2 : 1;
    if (input.docstatus !== expected) throw new ToolError("INVALID_ARGUMENT", "status conflicts with docstatus. Use status All for all documents in the selected document state.");
  }
  return [[doctype, "docstatus", "=", input.docstatus]];
}

function requireAggregateStatus(input: Record<string, unknown>, filter: string) {
  if (input.status && input.status !== "All") {
    throw new ToolError("INVALID_ARGUMENT", `Use ${filter} with status All or omit status. Do not narrow this aggregate filter to one operational status.`);
  }
  if (input.docstatus !== undefined && input.docstatus !== 1) {
    throw new ToolError("INVALID_ARGUMENT", `${filter} requires submitted documents. Set docstatus to 1 or omit it.`);
  }
}

export function invoiceFilters(doctype: string, input: Record<string, unknown>): unknown[] {
  if (input.unpaid_only || input.overdue_as_of) requireAggregateStatus(input, "unpaid_only or overdue_as_of");
  if (input.overdue_as_of && input.unpaid_only === false) {
    throw new ToolError("INVALID_ARGUMENT", "overdue_as_of requires unpaid invoices. Set unpaid_only to true or omit it.");
  }
  if (typeof input.overdue_as_of === "string") validateDateRange(input.overdue_as_of, input.overdue_as_of);
  return [
    ...documentStateFilters(doctype, input),
    ...(input.unpaid_only || input.overdue_as_of ? [
      ...(input.docstatus === undefined ? [[doctype, "docstatus", "=", 1]] : []),
      [doctype, "outstanding_amount", ">", 0],
    ] : []),
    ...(input.overdue_as_of ? [[doctype, "due_date", "<", input.overdue_as_of]] : []),
  ];
}

export function orderFilters(doctype: "Sales Order" | "Purchase Order", input: Record<string, unknown>): unknown[] {
  const purchase = doctype === "Purchase Order";
  const pendingKey = purchase ? "pending_receipt" : "pending_delivery";
  const deliveryField = purchase ? "schedule_date" : "delivery_date";
  const pending = input[pendingKey] || input.overdue_as_of;
  if (pending) requireAggregateStatus(input, `${pendingKey} or overdue_as_of`);
  if (input.overdue_as_of && input[pendingKey] === false) {
    throw new ToolError("INVALID_ARGUMENT", `overdue_as_of requires pending fulfilment. Set ${pendingKey} to true or omit it.`);
  }
  if (typeof input.overdue_as_of === "string") {
    validateDateRange(input.overdue_as_of, input.overdue_as_of);
    if (typeof input.delivery_from_date === "string" && input.delivery_from_date >= input.overdue_as_of) {
      throw new ToolError("INVALID_ARGUMENT", "delivery_from_date must be before overdue_as_of.");
    }
  }
  return [
    ...documentStateFilters(doctype, input),
    ...dateFilters(doctype, "transaction_date", input.from_date, input.to_date),
    ...dateFilters(doctype, deliveryField, input.delivery_from_date, input.delivery_to_date),
    ...(pending ? [
      ...(input.docstatus === undefined ? [[doctype, "docstatus", "=", 1]] : []),
      [doctype, purchase ? "per_received" : "per_delivered", "<", 100],
      [doctype, "status", "not in", ["Closed", "On Hold", "Completed", "Delivered"]],
      ...(!purchase ? [[doctype, "skip_delivery_note", "=", 0]] : []),
    ] : []),
    ...(input.overdue_as_of ? [[doctype, deliveryField, "<", input.overdue_as_of]] : []),
  ];
}
