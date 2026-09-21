import { describe, expect, it } from "vitest";
import { createNexWaveServer } from "../src/mcp";
import { dateFilters, documentStateFilters, invoiceFilters, orderFilters } from "../src/transaction-filters";

describe("transaction filter contracts", () => {
  it.each([
    ["list_sales_invoices", "Credit Note Issued", "Debit Note Issued"],
    ["list_purchase_invoices", "Debit Note Issued", "Credit Note Issued"],
    ["list_sales_orders", "To Deliver", "To Receive"],
    ["list_purchase_orders", "To Receive", "To Deliver"],
  ])("publishes only %s statuses and an explicit no-filter choice", (tool, valid, invalid) => {
    const schema = createNexWaveServer().toolInputSchemaJson(tool) as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.status.enum).toContain(valid);
    expect(schema.properties.status.enum).toContain("All");
    expect(schema.properties.status.enum).not.toContain(invalid);
  });

  it.each(["Sales Invoice", "Purchase Invoice"])("validates unpaid and overdue filters for %s", (doctype) => {
    for (const status of ["Draft", "Submitted", "Paid", "Unpaid", "Overdue", "Partly Paid", "Cancelled"]) {
      expect(() => invoiceFilters(doctype, { status, unpaid_only: true })).toThrow("status All");
      expect(() => invoiceFilters(doctype, { status, overdue_as_of: "2026-06-30" })).toThrow("status All");
    }
    expect(() => invoiceFilters(doctype, { docstatus: 0, unpaid_only: true })).toThrow("submitted");
    expect(() => invoiceFilters(doctype, { docstatus: 2, overdue_as_of: "2026-06-30" })).toThrow("submitted");
    expect(() => invoiceFilters(doctype, { unpaid_only: false, overdue_as_of: "2026-06-30" })).toThrow("unpaid invoices");
    expect(() => invoiceFilters(doctype, { overdue_as_of: "2026-02-30" })).toThrow("valid dates");
    for (const status of [undefined, "All"]) {
      expect(invoiceFilters(doctype, { status, unpaid_only: true, overdue_as_of: "2026-06-30" })).toEqual([
        [doctype, "docstatus", "=", 1], [doctype, "outstanding_amount", ">", 0], [doctype, "due_date", "<", "2026-06-30"],
      ]);
    }
    expect(invoiceFilters(doctype, { docstatus: 1, unpaid_only: true })).toEqual([
      [doctype, "docstatus", "=", 1], [doctype, "outstanding_amount", ">", 0],
    ]);
  });

  it.each(["Sales Invoice", "Purchase Invoice", "Sales Order", "Purchase Order"])("rejects conflicting document states for %s", (doctype) => {
    for (const [status, state] of [["Draft", 0], ["Cancelled", 2], ["Completed", 1]] as const) {
      expect(documentStateFilters(doctype, { status, docstatus: state })).toEqual([[doctype, "docstatus", "=", state]]);
      expect(() => documentStateFilters(doctype, { status, docstatus: (state + 1) % 3 })).toThrow("conflicts");
    }
  });

  it.each(["Sales Order", "Purchase Order"] as const)("keeps order and expected-delivery dates separate for %s", (doctype) => {
    const purchase = doctype === "Purchase Order";
    const pending = purchase ? "pending_receipt" : "pending_delivery";
    const date = purchase ? "schedule_date" : "delivery_date";
    const input = { status: "All", [pending]: true, from_date: "2026-01-01", to_date: "2026-06-30", delivery_from_date: "2026-06-01", delivery_to_date: "2026-06-30", overdue_as_of: "2026-06-15" };
    expect(orderFilters(doctype, input)).toEqual(expect.arrayContaining([
      [doctype, "transaction_date", ">=", "2026-01-01"], [doctype, "transaction_date", "<=", "2026-06-30"],
      [doctype, date, ">=", "2026-06-01"], [doctype, date, "<=", "2026-06-30"], [doctype, date, "<", "2026-06-15"],
      [doctype, "docstatus", "=", 1], [doctype, purchase ? "per_received" : "per_delivered", "<", 100],
    ]));
    if (!purchase) expect(orderFilters(doctype, input)).toContainEqual([doctype, "skip_delivery_note", "=", 0]);
    expect(() => orderFilters(doctype, { [pending]: true, status: "Draft" })).toThrow("status All");
    expect(() => orderFilters(doctype, { [pending]: true, docstatus: 0 })).toThrow("submitted");
    expect(() => orderFilters(doctype, { overdue_as_of: "2026-06-30", [pending]: false })).toThrow("pending fulfilment");
    expect(() => orderFilters(doctype, { delivery_from_date: "2026-06-30", overdue_as_of: "2026-06-30" })).toThrow("before overdue_as_of");
    expect(() => orderFilters(doctype, { delivery_from_date: "2026-07-01", delivery_to_date: "2026-06-30" })).toThrow("on or before");
    expect(() => orderFilters(doctype, { delivery_to_date: "2026-02-30" })).toThrow("valid dates");
    expect(orderFilters(doctype, { [pending]: false })).toEqual([]);
  });

  it("validates single-sided date bounds without inventing the other bound", () => {
    expect(dateFilters("Sales Invoice", "posting_date", "2026-01-01", undefined)).toEqual([["Sales Invoice", "posting_date", ">=", "2026-01-01"]]);
    expect(() => dateFilters("Purchase Order", "transaction_date", undefined, "2026-02-30")).toThrow("valid dates");
  });
});
