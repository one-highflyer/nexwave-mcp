import { expect, it } from "vitest";
import { documentDetails } from "../src/document-details";

it.each(["Sales Invoice", "Purchase Invoice", "Sales Order", "Purchase Order"])("returns bounded allowlisted item details for %s", (doctype) => {
  const items = Array.from({ length: 3 }, (_, idx) => ({ idx, item_code: `ITEM-${idx}`, qty: idx + 1, rate: 12, amount: 12 * (idx + 1), private_custom_field: "secret", owner: "hidden", nested: {} }));
  const first = documentDetails(doctype, { items }, 0, 2);
  expect(first.items).toEqual(items.slice(0, 2).map(({ idx, item_code, qty, rate, amount }) => ({ idx, item_code, qty, rate, amount })));
  expect(first.detail_meta).toMatchObject({ items: { count: 3, next_offset: 2, complete: false } });
  const last = documentDetails(doctype, { items }, 2, 2);
  expect(last.items).toEqual([{ idx: 2, item_code: "ITEM-2", qty: 3, rate: 12, amount: 36 }]);
  expect(last.detail_meta).toMatchObject({ items: { next_offset: null, complete: false, warning: "This is the final detail page. Combine it with earlier pages to obtain all returned rows." } });
});

it("returns the exact quotation line links for sales order items with the same item code", () => {
  const items = [
    { name: "SO-LINE-1", idx: 1, item_code: "ITEM-1", qty: 2, prevdoc_docname: "QUOTE-1", quotation_item: "QUOTE-LINE-2", po_detail: "not-a-sales-order-field" },
    { name: "SO-LINE-2", idx: 2, item_code: "ITEM-1", qty: 3, prevdoc_docname: "QUOTE-1", quotation_item: "QUOTE-LINE-1" },
  ];
  const first = documentDetails("Sales Order", { items }, 0, 1);
  expect(first.items).toEqual([{ name: "SO-LINE-1", idx: 1, item_code: "ITEM-1", qty: 2, prevdoc_docname: "QUOTE-1", quotation_item: "QUOTE-LINE-2" }]);
  expect(first.detail_meta).toMatchObject({ items: { next_offset: 1, complete: false } });
  const last = documentDetails("Sales Order", { items }, 1, 1);
  expect(last.items).toEqual([items[1]]);
});

it("returns purchase order and receipt line links for purchase invoice items", () => {
  const item = {
    name: "PI-LINE-1", item_code: "ITEM-1", qty: 2,
    purchase_order: "PO-1", po_detail: "PO-LINE-1",
    purchase_receipt: "RECEIPT-1", pr_detail: "RECEIPT-LINE-1",
    quotation_item: "not-a-purchase-invoice-field", private_custom_field: "hidden",
  };
  expect(documentDetails("Purchase Invoice", { items: [item] }, 0, 20)).toMatchObject({
    items: [{ name: "PI-LINE-1", item_code: "ITEM-1", qty: 2, purchase_order: "PO-1", po_detail: "PO-LINE-1", purchase_receipt: "RECEIPT-1", pr_detail: "RECEIPT-LINE-1" }],
    detail_meta: { items: { complete: true, count: 1 } },
  });
  const [returned] = documentDetails("Purchase Invoice", { items: [item] }, 0, 20).items as Record<string, unknown>[];
  expect(returned).not.toHaveProperty("quotation_item");
  expect(returned).not.toHaveProperty("private_custom_field");
});

it("returns payment invoice allocations and bank links without private fields", () => {
  expect(documentDetails("Payment Entry", { references: [{ reference_doctype: "Sales Invoice", reference_name: "INV-1", allocated_amount: 42, private_note: "hidden" }] }, 0, 20)).toMatchObject({ references: [{ reference_doctype: "Sales Invoice", reference_name: "INV-1", allocated_amount: 42 }], detail_meta: { references: { complete: true, count: 1 } } });
  expect(documentDetails("Bank Transaction", { payment_entries: [{ payment_document: "Payment Entry", payment_entry: "PAY-1", allocated_amount: 42, private_note: "hidden" }] }, 0, 20)).toMatchObject({ payment_entries: [{ payment_document: "Payment Entry", payment_entry: "PAY-1", allocated_amount: 42 }] });
});

it("does not claim completeness for unavailable or empty tables", () => {
  const missing = documentDetails("Sales Invoice", {}, 0, 20);
  expect(missing).not.toHaveProperty("items");
  expect(missing.detail_meta).toMatchObject({ items: { complete: false } });
  expect(documentDetails("Sales Invoice", { items: [] }, 0, 20)).toMatchObject({ items: [], detail_meta: { items: { count: 0, complete: false } } });
});

it.each([null, {}, [null], ["invalid"]])("rejects malformed child data: %j", (items) => {
  expect(() => documentDetails("Sales Invoice", { items }, 0, 20)).toThrow("UPSTREAM_INVALID_RESPONSE");
});

it.each(["Sales Order", "Purchase Invoice"])("returns saved tax and payment amounts with bounded pages for %s", (doctype) => {
  const taxes = Array.from({ length: 3 }, (_, idx) => ({
    name: `TAX-${idx}`, idx: idx + 1, charge_type: "On Net Total", account_head: "Tax - EX",
    rate: 15, tax_amount: 15, base_tax_amount: 30, total: 115, base_total: 230,
    tax_amount_after_discount_amount: 13.5, base_tax_amount_after_discount_amount: 27,
    cost_center: "Main - EX", included_in_print_rate: 0, category: "Total", add_deduct_tax: "Add",
    private_custom_field: "hidden", owner: "hidden",
  }));
  const payment_schedule = Array.from({ length: 3 }, (_, idx) => ({
    name: `TERM-${idx}`, idx: idx + 1, payment_term: "Net 30", due_date: "2026-12-01",
    invoice_portion: 100, payment_amount: 115, base_payment_amount: 230,
    paid_amount: 15, outstanding: 100, private_custom_field: "hidden", owner: "hidden",
  }));
  const first = documentDetails(doctype, { taxes, payment_schedule }, 0, 2);
  expect(first.taxes).toHaveLength(2);
  expect(first.payment_schedule).toHaveLength(2);
  expect(first.taxes).toEqual(taxes.slice(0, 2).map(({ private_custom_field, owner, category, add_deduct_tax, ...tax }) => ({
    ...tax, ...(doctype === "Purchase Invoice" ? { category, add_deduct_tax } : {}),
  })));
  expect(first.payment_schedule).toEqual(payment_schedule.slice(0, 2).map(({ private_custom_field, owner, ...term }) => term));
  expect(first.detail_meta).toMatchObject({ taxes: { count: 3, complete: false, next_offset: 2 }, payment_schedule: { count: 3, complete: false, next_offset: 2 } });
  const last = documentDetails(doctype, { taxes, payment_schedule }, 2, 2);
  expect(last.taxes).toHaveLength(1);
  expect(last.payment_schedule).toHaveLength(1);
  expect(last.detail_meta).toMatchObject({ taxes: { complete: false, next_offset: null }, payment_schedule: { complete: false, next_offset: null } });
  expect(documentDetails(doctype, { taxes: taxes.slice(0, 1), payment_schedule: payment_schedule.slice(0, 1) }, 0, 2).detail_meta).toMatchObject({ taxes: { complete: true }, payment_schedule: { complete: true } });
});

it("returns purchase invoice line accounting, tax, pricing and asset context", () => {
  const item = { item_code: "ITEM-1", expense_account: "Purchases - EX", cost_center: "Main - EX", item_tax_template: "Tax 15% - EX", price_list_rate: 100, discount_percentage: 10, discount_amount: 10, net_amount: 90, project: "PROJECT-1", is_fixed_asset: 1, asset: "ASSET-1", asset_category: "Equipment" };
  expect(documentDetails("Purchase Invoice", { items: [{ ...item, owner: "hidden", private_custom_field: "hidden" }] }, 0, 20).items).toEqual([item]);
});

it.each(["Sales Order", "Purchase Invoice"])("does not claim hidden tax or payment details are complete for %s", (doctype) => {
  const missing = documentDetails(doctype, {}, 0, 20);
  expect(missing).not.toHaveProperty("taxes");
  expect(missing).not.toHaveProperty("payment_schedule");
  expect(missing.detail_meta).toMatchObject({ taxes: { complete: false }, payment_schedule: { complete: false } });
  const empty = documentDetails(doctype, { taxes: [], payment_schedule: [] }, 0, 20);
  expect(empty.detail_meta).toMatchObject({ taxes: { count: 0, complete: false }, payment_schedule: { count: 0, complete: false } });
  const hidden = documentDetails(doctype, { taxes: [{ rate: {}, tax_amount: [], owner: "hidden" }], payment_schedule: [{ payment_amount: {}, owner: "hidden" }] }, 0, 20);
  expect(hidden.taxes).toEqual([{}]);
  expect(hidden.payment_schedule).toEqual([{}]);
});
