import { describe, expect, it } from "vitest";
import { mandatoryValidationMessage } from "../src/validation-errors";

function mandatory(doctype: string, fields: string, documentName = "TEST-001") {
  return { exc_type: "MandatoryError", exception: `frappe.exceptions.MandatoryError: [${doctype}, ${documentName}]: ${fields}` };
}

const FALLBACK = mandatoryValidationMessage({ exc_type: "MandatoryError" }, "Sales Order");

describe("safe mandatory-field validation errors", () => {
  it("returns header and child input names without a document name or row claim", () => {
    const message = mandatoryValidationMessage(mandatory("Sales Order", "delivery_date, uom, delivery_date", "PRIVATE-DOCUMENT"), "Sales Order");
    expect(message).toBe("NexWave requires these tool input fields: delivery_date, uom. Check the header and item inputs.");
    expect(message).not.toMatch(/PRIVATE-DOCUMENT|row/i);
  });

  it.each([
    ["Quotation", "company, party_name, item_code"],
    ["Sales Order", "customer, delivery_date, quotation_item"],
    ["Purchase Invoice", "supplier, expense_account, purchase_order"],
    ["Customer", "customer_name, territory, lead_name"],
    ["Lead", "first_name, company_name, email_id"],
  ])("uses only the fixed %s tool input list", (doctype, fields) => {
    expect(mandatoryValidationMessage(mandatory(doctype, fields), doctype)).toContain(`tool input fields: ${fields}.`);
  });

  it("gives configuration guidance for native generated fields", () => {
    const message = mandatoryValidationMessage(mandatory("Purchase Invoice", "credit_to, conversion_factor, amount"), "Purchase Invoice");
    expect(message).toContain("defaults or calculations");
    expect(message).toContain("site configuration");
    expect(message).not.toMatch(/credit_to|conversion_factor|amount/);
  });

  it("does not disclose custom identifiers alongside known input and generated fields", () => {
    const message = mandatoryValidationMessage(mandatory("Sales Order", "delivery_date, item_name, custom_private_value"), "Sales Order");
    expect(message).toContain("tool input fields: delivery_date.");
    expect(message).toContain("defaults or calculations");
    expect(message).toContain("a field that this tool cannot set");
    expect(message).not.toMatch(/item_name|custom_private_value/);
  });

  it("does not use another DocType's input allowlist", () => {
    const message = mandatoryValidationMessage(mandatory("Lead", "customer_name"), "Lead");
    expect(message).toContain("a field that this tool cannot set");
    expect(message).not.toContain("customer_name");
  });

  it.each([
    { exc_type: "MandatoryError" },
    { exc_type: "MandatoryError", exception: null },
    { exc_type: "MandatoryError", exception: [] },
    { exc_type: "MandatoryError", exception: {} },
    { exc_type: "MandatoryError", exception: "" },
    { exc_type: "MandatoryError", _server_messages: JSON.stringify([JSON.stringify({ message: "PRIVATE-VALUE" })]), exc: "PRIVATE-STACK" },
  ])("uses fixed guidance when the traceback is absent or invalid: %j", (payload) => {
    const message = mandatoryValidationMessage(payload, "Sales Order");
    expect(message).toBe(FALLBACK);
    expect(message).toContain("required inputs");
    expect(message).not.toMatch(/PRIVATE-VALUE|PRIVATE-STACK/);
  });

  it.each([
    "MandatoryError: [Sales Order, TEST-001]: delivery_date",
    "frappe.exceptions.MandatoryError: [Quotation, TEST-001]: delivery_date",
    "frappe.exceptions.MandatoryError: [Sales Order, ]: delivery_date",
    "frappe.exceptions.MandatoryError: [Sales Order, TEST[001]]: delivery_date",
    "frappe.exceptions.MandatoryError: [Sales Order, TEST-001]: delivery_date,qty",
    "frappe.exceptions.MandatoryError: [Sales Order, TEST-001]: delivery_date, ",
    "frappe.exceptions.MandatoryError: [Sales Order, TEST-001]: delivery_date extra",
    "frappe.exceptions.MandatoryError: [Sales Order, TEST-001]: Delivery_Date",
    "frappe.exceptions.MandatoryError: [Sales Order, TEST-001]: custom_unsafe-value",
    "frappe.exceptions.MandatoryError: [Sales Order, TEST-001]: delivery_date\nPRIVATE-STACK",
    "frappe.exceptions.MandatoryError: [Sales Order, TEST-001]: delivery_date\r",
    "frappe.exceptions.MandatoryError: [Sales Order, TEST-001]: delivery_date\u2028PRIVATE-STACK",
    "frappe.exceptions.MandatoryError: [Sales Order, TEST-001]: delivery_date\u0000",
    "PRIVATE-PREFIX frappe.exceptions.MandatoryError: [Sales Order, TEST-001]: delivery_date",
    "frappe.exceptions.MandatoryError: [Sales Order, TEST-001]: delivery_date: PRIVATE-VALUE",
  ])("rejects an incomplete or malformed native exception: %j", (exception) => {
    expect(mandatoryValidationMessage({ exc_type: "MandatoryError", exception }, "Sales Order")).toBe(FALLBACK);
  });

  it.each([
    mandatory("Sales Order", "delivery_date", "x".repeat(141)),
    mandatory("Sales Order", Array(51).fill("delivery_date").join(", ")),
    mandatory("Sales Order", "x".repeat(141)),
    { exc_type: "MandatoryError", exception: "x".repeat(4097) },
  ])("bounds exception size, names and field count: %j", (payload) => {
    expect(mandatoryValidationMessage(payload, "Sales Order")).toBe(FALLBACK);
  });

  it("accepts at most 50 valid fields before removing duplicate names", () => {
    expect(mandatoryValidationMessage(mandatory("Sales Order", Array(50).fill("delivery_date").join(", ")), "Sales Order"))
      .toContain("tool input fields: delivery_date.");
  });

  it.each(["Supplier", "__proto__", "Sales Order, TEST-001]: delivery_date"])('uses fixed guidance for unsupported expected DocType "%s"', (doctype) => {
    expect(mandatoryValidationMessage(mandatory("Sales Order", "delivery_date"), doctype)).toBe(FALLBACK);
  });

  it.each([null, undefined, [], "MandatoryError", 1, {}, { exc_type: "ValidationError", exception: "PRIVATE-VALUE" }, { exc_type: "frappe.exceptions.MandatoryError" }, { exc_type: ["MandatoryError"] }])
    ("leaves non-mandatory errors unchanged: %j", (payload) => {
      expect(mandatoryValidationMessage(payload, "Sales Order")).toBeUndefined();
    });
});
