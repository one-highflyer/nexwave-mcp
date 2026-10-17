import { expect, it } from "vitest";
import { documentDetails } from "../src/document-details";

it.each(["Sales Invoice", "Purchase Invoice", "Sales Order", "Purchase Order"])("returns bounded allowlisted item details for %s", (doctype) => {
  const items = Array.from({ length: 3 }, (_, idx) => ({ idx, item_code: `ITEM-${idx}`, qty: idx + 1, rate: 12, amount: 12 * (idx + 1), private_custom_field: "secret", owner: "hidden", nested: {} }));
  const first = documentDetails(doctype, { items }, 0, 2);
  expect(first.items).toEqual(items.slice(0, 2).map(({ idx, item_code, qty, rate, amount }) => ({ idx, item_code, qty, rate, amount })));
  expect(first.detail_meta).toMatchObject({ items: { count: 3, next_offset: 2, complete: false } });
  const last = documentDetails(doctype, { items }, 2, 2);
  expect(last.items).toEqual([{ idx: 2, item_code: "ITEM-2", qty: 3, rate: 12, amount: 36 }]);
  expect(last.detail_meta).toMatchObject({ items: { next_offset: null, complete: false } });
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
