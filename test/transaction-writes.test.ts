import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTransactionWrite } from "../src/transaction-writes";
import type { Env, NexWaveApiTokenAuthProps } from "../src/types";

type Row = Record<string, any>;
const props: NexWaveApiTokenAuthProps = {
  authType: "api_token", siteId: "test-site", siteName: "Example", baseUrl: "https://example.invalid",
  user: "user@example.invalid", upstreamApiKey: "test-key", upstreamApiSecret: "test-secret",
  writeCapabilities: ["sales_orders", "purchase_invoices"],
};
const modes = [
  { target: "Sales Order", source: "Quotation", party: "customer", partyId: "CUST-1", parent: "prevdoc_docname", child: "quotation_item", sourceId: "QTN-1", create: "create_draft_sales_order", update: "update_draft_sales_order", capability: "sales_orders" },
  { target: "Purchase Invoice", source: "Purchase Order", party: "supplier", partyId: "SUPP-1", parent: "purchase_order", child: "po_detail", sourceId: "PO-1", create: "create_draft_purchase_invoice", update: "update_draft_purchase_invoice", capability: "purchase_invoices" },
] as const;
type Mode = typeof modes[number];
const modified = "2025-01-10 12:00:00.000000";
const item = { item_code: "ITEM-1", qty: 2, uom: "Each" };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function environment(capabilities = '["sales_orders","purchase_invoices"]', failures: { complete?: boolean; unknown?: boolean } = {}) {
  const reservations = new Map<string, { fingerprint: string; state: string; document_name?: string }>();
  const site = { id: props.siteId, enabled: 1, base_url: props.baseUrl, auth_type: "api_token", write_capabilities: capabilities };
  const prepare = (query: string) => ({ bind(...values: unknown[]) {
    const key = JSON.stringify(query.startsWith("UPDATE write_requests SET state = 'complete'") ? values.slice(1) : values.slice(0, 4));
    return {
      first: async () => query.includes("FROM sites") ? site : reservations.get(key) ?? null,
      run: async () => {
        if ((failures.complete && query.includes("state = 'complete'")) || (failures.unknown && query.includes("state = 'unknown'"))) throw new Error("private D1 storage failure");
        let changes = 1;
        if (query.startsWith("INSERT INTO write_requests")) {
          if (reservations.has(key)) changes = 0;
          else reservations.set(key, { fingerprint: String(values[4]), state: "pending" });
        } else if (query.includes("state = 'complete'")) Object.assign(reservations.get(key)!, { state: "complete", document_name: values[0] });
        else if (query.includes("state = 'unknown'")) Object.assign(reservations.get(key)!, { state: "unknown" });
        return { meta: { changes } };
      },
    };
  } });
  return { env: { NEXWAVE_MCP_DB: { prepare } } as unknown as Env, reservations, site };
}
function source(mode: Mode, name = mode.sourceId): Row {
  return { name, doctype: mode.source, docstatus: 1, status: "Open", company: "Example Company", currency: "NZD",
    ...(mode.party === "customer" ? { quotation_to: "Customer", party_name: mode.partyId } : { supplier: mode.partyId }),
    items: [{ name: "SOURCE-ROW-1", ...item, qty: 10, rate: 12 }, { name: "SOURCE-ROW-2", ...item, qty: 5, rate: 24 }] };
}
function draft(mode: Mode): Row {
  return { name: "DRAFT-1", doctype: mode.target, docstatus: 0, modified, company: "Example Company", currency: "NZD",
    [mode.party]: mode.partyId, transaction_date: "2025-01-10", posting_date: "2025-01-10", delivery_date: "2025-01-20",
    items: [{ name: "TARGET-ROW-1", ...item, ...(mode.party === "customer" ? { delivery_date: "2025-01-20" } : {}), rate: 12 }], grand_total: 27.6 };
}
function create(mode: Mode, extra: Row = {}) {
  return { request_key: "test-create-1", company: "Example Company", [mode.party]: mode.partyId, items: [{ ...item, ...(mode.party === "customer" ? { delivery_date: "2025-01-20" } : {}) }], ...(mode.party === "customer" ? { transaction_date: "2025-01-10", delivery_date: "2025-01-20" } : {}), ...extra };
}
function update(mode: Mode, extra: Row = {}) {
  return { request_key: "test-update-1", name: "DRAFT-1", expected_modified: modified, ...extra };
}
function linked(mode: Mode, extra: Row = {}): Row { return { ...item, ...(mode.party === "customer" ? { delivery_date: "2025-01-20" } : {}), [mode.parent]: mode.sourceId, [mode.child]: "SOURCE-ROW-1", ...extra }; }

function upstream(mode: Mode) {
  const state = {
    current: draft(mode), sources: new Map<string, Row>([[mode.sourceId, source(mode)]]),
    mapped: (doc: Row): Row => doc,
    before: undefined as undefined | ((url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined),
  };
  const mock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const intercepted = state.before?.(url, init);
    if (intercepted) return intercepted;
    if (url.pathname.startsWith("/api/method/")) {
      const input = JSON.parse(String(init?.body));
      const src = state.sources.get(input.source_name)!;
      const mapped = { ...draft(mode), name: "new-draft-1", docstatus: 0,
        taxes: [{ charge_type: "On Net Total", account_head: "GST", rate: 15 }],
        items: src.items.filter((row: Row) => input.args.filtered_children.includes(row.name)).map((row: Row) => ({
          ...row, name: "new-child-1", parent: "new-draft-1", parenttype: mode.target,
          [mode.parent]: src.name, [mode.child]: row.name,
        })),
      };
      return Response.json({ message: state.mapped(mapped) });
    }
    if (init?.method === "POST" || init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      state.current = { ...state.current, ...body, name: "DRAFT-1", modified, private_field: "private",
        items: (body.items ?? state.current.items).map((row: Row, idx: number) => ({ ...row, name: row.name ?? `NEW-ROW-${idx + 1}` })),
      };
      return Response.json({ data: state.current });
    }
    const parts = url.pathname.split("/").map(decodeURIComponent);
    if (parts[3] === mode.source) return Response.json({ data: state.sources.get(parts[4]) });
    if (parts[3] === mode.target) return Response.json({ data: state.current });
    return Response.json({ data: { name: mode.partyId } });
  });
  vi.stubGlobal("fetch", mock);
  const saves = () => mock.mock.calls.filter(([url, init]) => url.includes("/api/resource/") && ["POST", "PUT"].includes(init?.method ?? ""));
  const maps = () => mock.mock.calls.filter(([url]) => url.includes("/api/method/"));
  const savedBody = () => JSON.parse(String(saves().at(-1)?.[1]?.body));
  return { state, mock, saves, maps, savedBody };
}

describe.each(modes)("$target draft writes", (mode) => {
  it("creates one standalone draft through standard Frappe permissions", async () => {
    const up = upstream(mode);
    const result = await executeTransactionWrite(environment().env, props, mode.create, create(mode));
    expect(up.maps()).toHaveLength(0);
    expect(up.saves()).toHaveLength(1);
    expect(up.saves()[0][0]).toBe(`https://example.invalid/api/resource/${encodeURIComponent(mode.target)}`);
    expect(up.saves()[0][1]?.headers).toMatchObject({ Authorization: "token test-key:test-secret" });
    expect(up.savedBody()).toMatchObject({ doctype: mode.target, docstatus: 0, company: "Example Company", [mode.party]: mode.partyId, items: [item] });
    expect(up.savedBody()).not.toHaveProperty("request_key");
    expect(up.savedBody().items[0]).not.toHaveProperty("rate");
    expect(result.structuredContent).toMatchObject({ doctype: mode.target, name: "DRAFT-1", replayed: false, document: { docstatus: 0, grand_total: 27.6 } });
    expect(JSON.stringify(result)).not.toContain("private_field");
  });

  it("updates a standalone draft and sends the exact concurrency timestamp", async () => {
    const up = upstream(mode);
    await executeTransactionWrite(environment().env, props, mode.update, update(mode, { items: [{ name: "TARGET-ROW-1", ...item, qty: 3 }] }));
    expect(up.saves()).toHaveLength(1);
    expect(up.saves()[0][1]?.method).toBe("PUT");
    expect(up.savedBody()).toMatchObject({ modified, docstatus: 0, items: [{ name: "TARGET-ROW-1", ...item, qty: 3, rate: 12 }] });
  });

  it("maps exact selected source rows with partial quantities and keeps duplicate item codes distinct", async () => {
    const up = upstream(mode);
    const result = await executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode, { qty: 3 }), linked(mode, { [mode.child]: "SOURCE-ROW-2", qty: 2 })] }));
    expect(up.maps()).toHaveLength(1);
    expect(up.maps()[0][0]).toBe(`https://example.invalid/api/method/${mode.party === "customer" ? "erpnext.selling.doctype.quotation.quotation.make_sales_order" : "erpnext.buying.doctype.purchase_order.purchase_order.make_purchase_invoice"}`);
    expect(JSON.parse(String(up.maps()[0][1]?.body))).toEqual({ source_name: mode.sourceId, args: { filtered_children: ["SOURCE-ROW-1", "SOURCE-ROW-2"] } });
    expect(up.savedBody().items).toMatchObject([{ qty: 3, rate: 12, [mode.child]: "SOURCE-ROW-1" }, { qty: 2, rate: 24, [mode.child]: "SOURCE-ROW-2" }]);
    for (const row of up.savedBody().items) {
      expect(row).not.toHaveProperty("name");
      expect(row).not.toHaveProperty("parent");
      expect(row).not.toHaveProperty("parenttype");
    }
    expect((result.structuredContent.document as Row).items).toMatchObject([{ [mode.parent]: mode.sourceId, [mode.child]: "SOURCE-ROW-1" }, { [mode.parent]: mode.sourceId, [mode.child]: "SOURCE-ROW-2" }]);
  });

  it("allows split rows when their combined quantity fits the exact source row", async () => {
    const up = upstream(mode);
    await executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode, { qty: 4 }), linked(mode, { qty: 6 })] }));
    expect(up.savedBody().items.map((r: Row) => r.qty)).toEqual([4, 6]);
    expect(JSON.parse(String(up.maps()[0][1]?.body)).args.filtered_children).toEqual(["SOURCE-ROW-1"]);
  });

  it("rejects split rows whose combined quantity exceeds the remaining quantity", async () => {
    const up = upstream(mode);
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode, { qty: 6 }), linked(mode, { qty: 5 })] }))).rejects.toThrow("available source quantity");
    expect(up.saves()).toHaveLength(0);
  });

  it("uses the native remaining quantity rather than the original source quantity", async () => {
    const up = upstream(mode); up.state.mapped = (doc) => ({ ...doc, items: doc.items.map((r: Row) => ({ ...r, qty: 1 })) });
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("available source quantity");
    expect(up.saves()).toHaveLength(0);
  });

  it.each([
    ["wrong source row", { [mode.child]: "NOT-IN-THIS-DOC" }],
    ["wrong item", { item_code: "ITEM-OTHER" }],
    ["wrong UOM", { uom: "Box" }],
  ])("rejects %s before conversion or reservation", async (_label, patch) => {
    const up = upstream(mode); const ctx = environment();
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode, { items: [linked(mode, patch)] }))).rejects.toThrow("INVALID_ARGUMENT");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it.each([mode.parent, mode.child])("rejects an incomplete source pair missing %s", async (field) => {
    const up = upstream(mode); const row = linked(mode); delete row[field];
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [row] }))).rejects.toThrow("Supply both");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0);
  });

  it.each([
    { company: "Other Company" }, { currency: "USD" }, { docstatus: 0 }, { docstatus: 2 },
    { status: "Closed" }, { status: "On Hold" }, { status: "Cancelled" }, { status: "Lost" },
    mode.party === "customer" ? { party_name: "CUST-OTHER" } : { supplier: "SUPP-OTHER" },
  ])("rejects incompatible source %j before conversion", async (patch) => {
    const up = upstream(mode); Object.assign(up.state.sources.get(mode.sourceId)!, patch);
    const ctx = environment();
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode, { currency: "NZD", items: [linked(mode)] }))).rejects.toThrow("INVALID_ARGUMENT");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it("rejects six source documents before any native conversion", async () => {
    const up = upstream(mode);
    const items = Array.from({ length: 6 }, (_, i) => {
      const name = `${mode.sourceId}-${i}`; up.state.sources.set(name, source(mode, name as typeof mode.sourceId));
      return linked(mode, { [mode.parent]: name });
    });
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items }))).rejects.toThrow("at most five");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0);
  });

  it("combines equal percentage tax settings when derived amounts differ between sources", async () => {
    const up = upstream(mode); const other = `${mode.sourceId}-OTHER`;
    up.state.sources.set(other, source(mode, other as typeof mode.sourceId));
    let mappedCount = 0;
    up.state.mapped = (doc) => ({ ...doc, taxes: [{ charge_type: "On Net Total", account_head: "GST", rate: 15, tax_amount: ++mappedCount * 10 }] });
    await executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode), linked(mode, { [mode.parent]: other })] }));
    expect(up.maps()).toHaveLength(2); expect(up.saves()).toHaveLength(1);
    expect(up.savedBody().items).toMatchObject([{ [mode.parent]: mode.sourceId }, { [mode.parent]: other }]);
  });

  it.each(["percentage rate", "actual amount"])("rejects conflicting source tax %s settings", async (difference) => {
    const up = upstream(mode); const other = `${mode.sourceId}-OTHER`;
    up.state.sources.set(other, source(mode, other as typeof mode.sourceId));
    let mappedCount = 0;
    up.state.mapped = (doc) => ({ ...doc, taxes: [difference === "percentage rate"
      ? { charge_type: "On Net Total", account_head: "GST", rate: ++mappedCount * 15 }
      : { charge_type: "Actual", account_head: "Freight", tax_amount: ++mappedCount * 10 }] });
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode), linked(mode, { [mode.parent]: other })] }))).rejects.toThrow("Source tax rows differ");
    expect(up.saves()).toHaveLength(0);
  });

  it("rejects mixed source currencies even when the target currency was omitted", async () => {
    const up = upstream(mode); const other = `${mode.sourceId}-OTHER`;
    up.state.sources.set(other, { ...source(mode, other as typeof mode.sourceId), currency: "USD" });
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode), linked(mode, { [mode.parent]: other })] }))).rejects.toThrow("same currency");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0);
  });

  it("preserves a source percentage header discount for a partial conversion and returns the saved discount", async () => {
    const up = upstream(mode);
    const settings = { apply_discount_on: "Net Total", additional_discount_percentage: 10, discount_amount: 12 };
    Object.assign(up.state.sources.get(mode.sourceId)!, settings);
    up.state.mapped = (doc) => ({ ...doc, ...settings });
    Object.assign(up.state.current, { discount_amount: 2.4 });
    const result = await executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode, { qty: 2 })] }));
    expect(up.savedBody()).toMatchObject({ apply_discount_on: "Net Total", additional_discount_percentage: 10, items: [{ qty: 2 }] });
    expect(up.savedBody().discount_amount ?? 0).toBe(0);
    expect(result.structuredContent).toMatchObject({ document: { apply_discount_on: "Net Total", additional_discount_percentage: 10, discount_amount: 2.4 } });
  });

  it("preserves source tax category and rounding defaults", async () => {
    const up = upstream(mode); const context = { tax_category: "Standard", disable_rounded_total: 1 };
    Object.assign(up.state.sources.get(mode.sourceId)!, context);
    up.state.mapped = (doc) => ({ ...doc, ...context });
    const result = await executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }));
    expect(up.savedBody()).toMatchObject(context);
    expect(result.structuredContent.document).toMatchObject(context);
  });

  it.each([{ tax_category: "Different" }, { disable_rounded_total: 1 }])("rejects conflicting source tax and rounding settings %j", async (context) => {
    const up = upstream(mode); const other = `${mode.sourceId}-OTHER`;
    up.state.sources.set(other, { ...source(mode, other as typeof mode.sourceId), ...context });
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode), linked(mode, { [mode.parent]: other })] }))).rejects.toThrow("same tax category and rounding");
    expect(up.saves()).toHaveLength(0); expect(up.maps()).toHaveLength(0);
  });

  it("combines multiple sources with the same percentage discount and basis", async () => {
    const up = upstream(mode); const other = `${mode.sourceId}-OTHER`;
    const settings = { apply_discount_on: "Net Total", additional_discount_percentage: 10 };
    Object.assign(up.state.sources.get(mode.sourceId)!, settings, { discount_amount: 12 });
    up.state.sources.set(other, { ...source(mode, other as typeof mode.sourceId), ...settings, discount_amount: 24 });
    up.state.mapped = (doc) => ({ ...doc, ...settings, discount_amount: 36 });
    await executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode), linked(mode, { [mode.parent]: other })] }));
    expect(up.maps()).toHaveLength(2); expect(up.saves()).toHaveLength(1);
    expect(up.savedBody()).toMatchObject(settings);
    expect(up.savedBody().discount_amount ?? 0).toBe(0);
  });

  it.each([
    { apply_discount_on: "Net Total", additional_discount_percentage: 5 },
    { apply_discount_on: "Grand Total", additional_discount_percentage: 10 },
    { apply_discount_on: "Net Total", additional_discount_percentage: 0 },
  ])("rejects mixed source header discount settings %j before conversion", async (different) => {
    const up = upstream(mode); const ctx = environment(); const other = `${mode.sourceId}-OTHER`;
    Object.assign(up.state.sources.get(mode.sourceId)!, { apply_discount_on: "Net Total", additional_discount_percentage: 10, discount_amount: 12 });
    up.state.sources.set(other, { ...source(mode, other as typeof mode.sourceId), ...different, discount_amount: 0 });
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode, { items: [linked(mode), linked(mode, { [mode.parent]: other })] }))).rejects.toThrow("INVALID_ARGUMENT");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it("rejects discounted source lines mixed with unlinked lines before conversion", async () => {
    const up = upstream(mode); const ctx = environment();
    Object.assign(up.state.sources.get(mode.sourceId)!, { apply_discount_on: "Net Total", additional_discount_percentage: 10, discount_amount: 12 });
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode, { items: [linked(mode), { ...item }] }))).rejects.toThrow("INVALID_ARGUMENT");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it("rejects fixed-amount source header discounts rather than guessing a partial allocation", async () => {
    const up = upstream(mode); const ctx = environment();
    Object.assign(up.state.sources.get(mode.sourceId)!, { apply_discount_on: "Net Total", additional_discount_percentage: 0, discount_amount: 12 });
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("INVALID_ARGUMENT");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it("retains an existing draft's fixed header discount during a header-only update", async () => {
    const up = upstream(mode);
    Object.assign(up.state.current, { apply_discount_on: "Grand Total", additional_discount_percentage: 0, discount_amount: 7 });
    up.state.current.items = [{ name: "TARGET-ROW-1", ...linked(mode) }];
    const sourceSettings = { apply_discount_on: "Net Total", additional_discount_percentage: 0, discount_amount: 12 };
    Object.assign(up.state.sources.get(mode.sourceId)!, sourceSettings);
    up.state.mapped = (doc) => ({ ...doc, ...sourceSettings });
    const fields = mode.party === "customer" ? { delivery_date: "2025-02-01" } : { bill_no: "BILL-DISCOUNT" };
    const result = await executeTransactionWrite(environment().env, props, mode.update, update(mode, fields));
    expect(up.saves()).toHaveLength(1);
    for (const field of ["apply_discount_on", "additional_discount_percentage", "discount_amount"]) expect(up.savedBody()).not.toHaveProperty(field);
    expect(result.structuredContent).toMatchObject({ document: { apply_discount_on: "Grand Total", additional_discount_percentage: 0, discount_amount: 7 } });
  });

  it("keeps source links and current child IDs when updates omit link fields", async () => {
    const up = upstream(mode); up.state.current.items = [{ name: "TARGET-ROW-1", ...linked(mode), rate: 12, conversion_factor: 1, project: "PROJECT-1" }];
    const result = await executeTransactionWrite(environment().env, props, mode.update, update(mode, { items: [{ name: "TARGET-ROW-1", ...item, qty: 3 }] }));
    expect(up.savedBody().items).toEqual([{ name: "TARGET-ROW-1", ...linked(mode, { qty: 3 }), rate: 12, conversion_factor: 1, project: "PROJECT-1" }]);
    expect((result.structuredContent.document as Row).items).toMatchObject([{ name: "TARGET-ROW-1", [mode.parent]: mode.sourceId, [mode.child]: "SOURCE-ROW-1" }]);
  });

  it("keeps source rows when changing only a header", async () => {
    const up = upstream(mode); up.state.current.items = [{ name: "TARGET-ROW-1", ...linked(mode) }];
    const fields = mode.party === "customer" ? { delivery_date: "2025-02-01" } : { bill_no: "BILL-123" };
    await executeTransactionWrite(environment().env, props, mode.update, update(mode, fields));
    expect(up.savedBody()).not.toHaveProperty("items");
    expect(up.state.current.items[0]).toMatchObject(linked(mode));
  });

  it.each([
    { name: "TARGET-ROW-1", ...item, [mode.child]: "SOURCE-ROW-2" },
    { name: "TARGET-ROW-1", ...item, [mode.parent]: "SOURCE-OTHER" },
    { name: "TARGET-ROW-1", ...item, item_code: "ITEM-OTHER" },
    { name: "TARGET-ROW-1", ...item, uom: "Box" },
  ])("rejects changing existing source identity %j", async (row) => {
    const up = upstream(mode); up.state.current.items = [{ name: "TARGET-ROW-1", ...linked(mode) }];
    await expect(executeTransactionWrite(environment().env, props, mode.update, update(mode, { items: [row] }))).rejects.toThrow("INVALID_ARGUMENT");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0);
  });

  it.each([
    [{ name: "FOREIGN-ROW-1", ...item }],
    [{ name: "TARGET-ROW-1", ...item }, { name: "TARGET-ROW-1", ...item }],
    [{ ...item }],
    [{ name: "TARGET-ROW-1", new_item: true, ...item }],
  ])("rejects foreign, duplicate, or ambiguous update row IDs %j", async (...items) => {
    const up = upstream(mode);
    await expect(executeTransactionWrite(environment().env, props, mode.update, update(mode, { items }))).rejects.toThrow("INVALID_ARGUMENT");
    expect(up.saves()).toHaveLength(0);
  });

  it("adds a new update line only with explicit new_item intent", async () => {
    const up = upstream(mode);
    await executeTransactionWrite(environment().env, props, mode.update, update(mode, { items: [{ name: "TARGET-ROW-1", ...item }, { new_item: true, ...linked(mode) }] }));
    expect(up.savedBody().items[1]).toMatchObject(linked(mode));
    expect(up.savedBody().items[1]).not.toHaveProperty("new_item");
    expect(up.savedBody().items[1]).not.toHaveProperty("name");
  });

  it.each([{ item_code: "ITEM-OTHER" }, { uom: "Box" }])("rejects standalone row identity changes that could retain stale defaults %j", async (patch) => {
    const up = upstream(mode); up.state.current.items[0].expense_account = "OLD-EXPENSE"; up.state.current.items[0].conversion_factor = 12;
    await expect(executeTransactionWrite(environment().env, props, mode.update, update(mode, { items: [{ name: "TARGET-ROW-1", ...item, ...patch }] }))).rejects.toThrow("cannot be changed");
    expect(up.saves()).toHaveLength(0);
  });

  it("rejects unavailable current item rows rather than guessing links", async () => {
    const up = upstream(mode); delete up.state.current.items;
    const fields = mode.party === "customer" ? { delivery_date: "2025-02-01" } : { bill_no: "BILL-1" };
    await expect(executeTransactionWrite(environment().env, props, mode.update, update(mode, fields))).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
    expect(up.saves()).toHaveLength(0);
  });

  it("rejects stale modifications and submitted target documents without mutation", async () => {
    const up = upstream(mode);
    const fields = mode.party === "customer" ? { delivery_date: "2025-02-01" } : { bill_no: "BILL-123" };
    await expect(executeTransactionWrite(environment().env, props, mode.update, update(mode, { ...fields, expected_modified: "old" }))).rejects.toThrow("CONFLICT");
    up.state.current.docstatus = 1;
    await expect(executeTransactionWrite(environment().env, props, mode.update, update(mode, fields))).rejects.toThrow("Only draft");
    expect(up.saves()).toHaveLength(0);
  });

  it("requires a full item array when changing pricing context", async () => {
    const up = upstream(mode);
    await expect(executeTransactionWrite(environment().env, props, mode.update, update(mode, { currency: "USD" }))).rejects.toThrow("full items array");
    expect(up.saves()).toHaveLength(0);
  });

  it.each(["price list", "date"])("clears inherited FX for a same-currency update with a changed %s", async (change) => {
    const up = upstream(mode);
    const listField = mode.party === "customer" ? "selling_price_list" : "buying_price_list";
    const dateField = mode.party === "customer" ? "transaction_date" : "posting_date";
    Object.assign(up.state.current, { conversion_rate: 2, plc_conversion_rate: 3, price_list_currency: "USD", [listField]: "Original List" });
    const context = change === "price list" ? { [listField]: "Changed List" } : { [dateField]: "2025-01-11" };
    await executeTransactionWrite(environment().env, props, mode.update, update(mode, { currency: "NZD", ...context, items: [{ name: "TARGET-ROW-1", ...item }] }));
    expect(up.savedBody()).toMatchObject({ currency: "NZD", conversion_rate: 0, plc_conversion_rate: 0, price_list_currency: "" });
  });

  it.each(["price list", "date"])("clears mapped FX for a create request with a changed %s", async (change) => {
    const up = upstream(mode);
    const listField = mode.party === "customer" ? "selling_price_list" : "buying_price_list";
    const dateField = mode.party === "customer" ? "transaction_date" : "posting_date";
    up.state.mapped = (doc) => ({ ...doc, conversion_rate: 2, plc_conversion_rate: 3, price_list_currency: "USD", [listField]: "Original List" });
    const context = change === "price list" ? { [listField]: "Changed List" } : { [dateField]: "2025-01-11" };
    await executeTransactionWrite(environment().env, props, mode.create, create(mode, { currency: "NZD", ...context, items: [linked(mode)] }));
    expect(up.savedBody()).toMatchObject({ currency: "NZD", conversion_rate: 0, plc_conversion_rate: 0, price_list_currency: "" });
  });

  it.each([{ docstatus: 1 }, { flags: { ignore_permissions: true } }, { update_stock: 1 }, { custom_field: "unsafe" }])("rejects unsafe top-level fields %j", async (extra) => {
    const up = upstream(mode);
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, extra))).rejects.toThrow("INVALID_ARGUMENT");
    expect(up.mock).not.toHaveBeenCalled();
  });

  it.each([{ name: "forged" }, { flags: { ignore_permissions: true } }, { docstatus: 1 }, { purchase_receipt: "RECEIPT-1" }])("rejects unsafe item fields %j", async (extra) => {
    const up = upstream(mode);
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [{ ...item, ...extra }] }))).rejects.toThrow("INVALID_ARGUMENT");
    expect(up.mock).not.toHaveBeenCalled();
  });

  it("rejects bad dates and more than fifty rows before Frappe access", async () => {
    const up = upstream(mode); const dateField = mode.party === "customer" ? "transaction_date" : "posting_date";
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { [dateField]: "2025-02-30" }))).rejects.toThrow("INVALID_ARGUMENT");
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: Array.from({ length: 51 }, () => item) }))).rejects.toThrow("INVALID_ARGUMENT");
    expect(up.mock).not.toHaveBeenCalled();
  });

  it("does not pass arbitrary mapper headers or temporary identities to the save", async () => {
    const up = upstream(mode); up.state.mapped = (doc) => ({ ...doc, flags: { ignore_permissions: true }, docstatus: 1, custom_field: "private", owner: "owner@example.invalid", update_stock: 1, is_paid: 1, is_return: 1 });
    await executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }));
    const body = up.savedBody();
    expect(body).toMatchObject({ docstatus: 0, doctype: mode.target, currency: "NZD", taxes: [{ account_head: "GST", rate: 15 }] });
    for (const field of ["name", "flags", "custom_field", "owner", "is_paid", "is_return"]) expect(body).not.toHaveProperty(field);
    if (mode.party === "supplier") expect(body.update_stock).toBe(0);
  });

  it.each([{ company: "Other Company" }, { currency: "USD" }, { [mode.party]: "OTHER-PARTY" }])("rejects a mapper that changes trusted source context %j", async (patch) => {
    const up = upstream(mode); up.state.mapped = (doc) => ({ ...doc, ...patch });
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("converted draft does not match");
    expect(up.saves()).toHaveLength(0);
  });

  it("checks both token and current site capabilities independently", async () => {
    const up = upstream(mode); const wrong = mode.capability === "sales_orders" ? "purchase_invoices" : "sales_orders";
    for (const granted of [undefined, [], [wrong], ["quotations"]] as NexWaveApiTokenAuthProps["writeCapabilities"][]) {
      await expect(executeTransactionWrite(environment().env, { ...props, writeCapabilities: granted }, mode.create, create(mode))).rejects.toThrow("PERMISSION_DENIED");
    }
    await expect(executeTransactionWrite(environment("[]").env, props, mode.create, create(mode))).rejects.toThrow("PERMISSION_DENIED");
    expect(up.mock).not.toHaveBeenCalled();
  });

  it("replays by reading the completed document without converting or saving twice", async () => {
    const up = upstream(mode); const ctx = environment(); const input = create(mode, { items: [linked(mode)] });
    await executeTransactionWrite(ctx.env, props, mode.create, input);
    const replay = await executeTransactionWrite(ctx.env, props, mode.create, { ...input });
    expect(replay.structuredContent.replayed).toBe(true); expect(up.maps()).toHaveLength(1); expect(up.saves()).toHaveLength(1);
    await expect(executeTransactionWrite(ctx.env, props, mode.create, { ...input, currency: "USD" })).rejects.toThrow("CONFLICT");
  });

  it("reserves concurrent identical requests before conversion and creates at most one draft", async () => {
    const up = upstream(mode); const ctx = environment(); const input = create(mode, { items: [linked(mode)] });
    const outcomes = await Promise.allSettled([executeTransactionWrite(ctx.env, props, mode.create, input), executeTransactionWrite(ctx.env, props, mode.create, input)]);
    expect(outcomes.some((r) => r.status === "fulfilled")).toBe(true);
    expect(up.maps()).toHaveLength(1); expect(up.saves()).toHaveLength(1);
  });

  it("does not retry an uncertain mutation or release its request key", async () => {
    const up = upstream(mode); const ctx = environment();
    up.state.before = (url, init) => { if (url.pathname.startsWith("/api/resource/") && init?.method === "POST") throw new Error("response lost after save"); };
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode))).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode))).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(up.saves()).toHaveLength(1); expect([...ctx.reservations.values()][0].state).toBe("unknown");
  });

  it("does not retry a native conversion after an uncertain response", async () => {
    const up = upstream(mode); const ctx = environment(); const input = create(mode, { items: [linked(mode)] });
    up.state.before = (url) => { if (url.pathname.startsWith("/api/method/")) throw new Error("conversion response lost"); };
    await expect(executeTransactionWrite(ctx.env, props, mode.create, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    await expect(executeTransactionWrite(ctx.env, props, mode.create, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(up.maps()).toHaveLength(1); expect(up.saves()).toHaveLength(0);
  });

  it.each(["conversion", "save", "completion record"])("keeps %s failure uncertain when recording the unknown state also fails", async (failure) => {
    const up = upstream(mode);
    const ctx = environment(undefined, { complete: failure === "completion record", unknown: true });
    const input = create(mode, { items: [linked(mode)] });
    up.state.before = (url, init) => {
      if ((failure === "conversion" && url.pathname.startsWith("/api/method/"))
        || (failure === "save" && url.pathname.startsWith("/api/resource/") && init?.method === "POST")) throw new Error("upstream response lost");
    };
    const first = executeTransactionWrite(ctx.env, props, mode.create, input);
    await expect(first).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    await expect(first).rejects.not.toThrow("private D1 storage failure");
    expect([...ctx.reservations.values()][0].state).toBe("pending");
    await expect(executeTransactionWrite(ctx.env, props, mode.create, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(up.maps()).toHaveLength(1);
    expect(up.saves()).toHaveLength(failure === "conversion" ? 0 : 1);
  });

  it("marks a saved document with missing source links as uncertain and prevents replay writes", async () => {
    const up = upstream(mode); const ctx = environment(); const input = create(mode, { items: [linked(mode)] });
    up.state.before = (url, init) => url.pathname.startsWith("/api/resource/") && init?.method === "POST"
      ? Response.json({ data: { ...draft(mode), items: [{ name: "SAVED-ROW-1", ...item }] } }) : undefined;
    await expect(executeTransactionWrite(ctx.env, props, mode.create, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    await expect(executeTransactionWrite(ctx.env, props, mode.create, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(up.saves()).toHaveLength(1); expect([...ctx.reservations.values()][0].state).toBe("unknown");
  });

  it("keeps safe upstream write errors without leaking private response data", async () => {
    const up = upstream(mode);
    up.state.before = (url, init) => url.pathname.startsWith("/api/resource/") && init?.method === "PUT" ? new Response("private account detail", { status: 417 }) : undefined;
    const input = update(mode, { items: [{ name: "TARGET-ROW-1", ...item }] });
    const promise = executeTransactionWrite(environment().env, props, mode.update, input);
    await expect(promise).rejects.toThrow("VALIDATION_FAILED"); await expect(promise).rejects.not.toThrow("private account detail");
    expect(up.saves()).toHaveLength(1);
  });

  it("stops before conversion when source read access is denied", async () => {
    const up = upstream(mode); const ctx = environment();
    up.state.before = (url) => decodeURIComponent(url.pathname).includes(`/resource/${mode.source}/`) ? new Response("private source", { status: 403 }) : undefined;
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("PERMISSION_DENIED");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });
});

describe("transaction-specific controls", () => {
  it("names missing header and line delivery dates before any request", async () => {
    const mode = modes[0]; const up = upstream(mode); const ctx = environment();
    const input = create(mode, { items: [{ ...item }, { ...item }] }); delete input.delivery_date;
    const pending = executeTransactionWrite(ctx.env, props, mode.create, input);
    await expect(pending).rejects.toThrow("delivery_date");
    await expect(pending).rejects.toThrow("items[0].delivery_date");
    await expect(pending).rejects.toThrow("items[1].delivery_date");
    expect(up.mock).not.toHaveBeenCalled(); expect(ctx.reservations.size).toBe(0);
  });

  it.each(["2025-02-30", "not-a-date"])("rejects an invalid delivery date %s before any request", async (delivery_date) => {
    const mode = modes[0]; const up = upstream(mode); const ctx = environment();
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode, { delivery_date }))).rejects.toThrow("delivery_date");
    expect(up.mock).not.toHaveBeenCalled(); expect(ctx.reservations.size).toBe(0);
  });

  it("names each delivery date before the order date", async () => {
    const mode = modes[0]; const up = upstream(mode); const ctx = environment();
    const pending = executeTransactionWrite(ctx.env, props, mode.create, create(mode, { delivery_date: "2025-01-09", items: [{ ...item, delivery_date: "2025-01-08" }] }));
    await expect(pending).rejects.toThrow("transaction_date");
    await expect(pending).rejects.toThrow("items[0].delivery_date");
    expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it("uses the site date when the order date is defaulted", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-01T11:30:00Z"));
    const mode = modes[0]; const up = upstream(mode); const ctx = environment();
    up.state.before = (url) => url.pathname.endsWith("get_time_zone") ? Response.json({ message: { time_zone: "Pacific/Auckland" } }) : undefined;
    const input = create(mode, { delivery_date: "2030-01-01", items: [{ ...item, delivery_date: "2030-01-01" }] }); delete input.transaction_date;
    await expect(executeTransactionWrite(ctx.env, props, mode.create, input)).rejects.toThrow("transaction_date");
    expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it.each(["header", "line"])("refuses an existing order with a missing or hidden %s date", async (scope) => {
    const mode = modes[0]; const up = upstream(mode); const ctx = environment();
    if (scope === "header") delete up.state.current.delivery_date; else delete up.state.current.items[0].delivery_date;
    await expect(executeTransactionWrite(ctx.env, props, mode.update, update(mode, { transaction_date: "2025-01-11", items: [{ name: "TARGET-ROW-1", ...item }] }))).rejects.toThrow(scope === "header" ? "delivery_date" : "items[0].delivery_date");
    expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it("retains saved dates on named rows and requires a confirmed date on new rows", async () => {
    const mode = modes[0]; const up = upstream(mode); const ctx = environment();
    await executeTransactionWrite(ctx.env, props, mode.update, update(mode, { items: [{ name: "TARGET-ROW-1", ...item, qty: 3 }] }));
    expect(up.savedBody().items[0].delivery_date).toBe("2025-01-20");
    expect(up.savedBody()).not.toHaveProperty("delivery_date");
    await expect(executeTransactionWrite(ctx.env, props, mode.update, update(mode, { request_key: "new-row-missing-date", items: [{ new_item: true, ...item }] }))).rejects.toThrow("delivery_date");
    expect(up.saves()).toHaveLength(1);
  });

  it("preserves the native Maintenance order type from a linked quotation", async () => {
    const mode = modes[0]; const up = upstream(mode);
    up.state.sources.get(mode.sourceId)!.order_type = "Maintenance";
    up.state.mapped = (doc) => ({ ...doc, order_type: "Maintenance" });
    const result = await executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }));
    expect(up.savedBody().order_type).toBe("Maintenance");
    expect(result.structuredContent).toMatchObject({ document: { order_type: "Maintenance" } });
  });

  it("rejects mixed Sales and Maintenance source quotation types before conversion", async () => {
    const mode = modes[0]; const up = upstream(mode); const other = "QTN-OTHER";
    up.state.sources.get(mode.sourceId)!.order_type = "Sales";
    up.state.sources.set(other, { ...source(mode, other as typeof mode.sourceId), order_type: "Maintenance" });
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode), linked(mode, { [mode.parent]: other })] }))).rejects.toThrow("same order type");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0);
  });

  it("rejects a mapper order type that differs from the source quotation", async () => {
    const mode = modes[0]; const up = upstream(mode);
    up.state.sources.get(mode.sourceId)!.order_type = "Maintenance";
    up.state.mapped = (doc) => ({ ...doc, order_type: "Sales" });
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("source quotation order type");
    expect(up.maps()).toHaveLength(1); expect(up.saves()).toHaveLength(0);
  });

  it("rejects a source quotation order type that differs from the existing Sales Order", async () => {
    const mode = modes[0]; const up = upstream(mode);
    up.state.current.order_type = "Sales";
    up.state.sources.get(mode.sourceId)!.order_type = "Maintenance";
    up.state.current.items = [{ name: "TARGET-ROW-1", ...linked(mode) }];
    await expect(executeTransactionWrite(environment().env, props, mode.update, update(mode, { items: [{ name: "TARGET-ROW-1", ...item, qty: 3 }] }))).rejects.toThrow("same order type");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0);
  });

  it("rejects a Lead quotation without an exact Customer link before conversion", async () => {
    const mode = modes[0]; const up = upstream(mode);
    Object.assign(up.state.sources.get(mode.sourceId)!, { quotation_to: "Lead", party_name: "LEAD-1" });
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("Customer");
    expect(up.maps()).toHaveLength(0); expect(up.saves()).toHaveLength(0);
  });

  it("retains existing Purchase Receipt and other source fields from raw rows", async () => {
    const mode = modes[1]; const up = upstream(mode);
    const existing = { name: "TARGET-ROW-1", ...linked(mode), rate: 12, purchase_receipt: "PR-1", pr_detail: "PR-ROW-1", material_request: "MR-1", material_request_item: "MR-ROW-1", project: "PROJECT-1" };
    up.state.current.items = [existing];
    const result = await executeTransactionWrite(environment().env, props, mode.update, update(mode, { items: [{ name: "TARGET-ROW-1", ...item, qty: 4 }] }));
    expect(up.savedBody().items).toEqual([{ ...existing, qty: 4 }]);
    expect((result.structuredContent.document as Row).items).toMatchObject([{ purchase_order: "PO-1", po_detail: "SOURCE-ROW-1", purchase_receipt: "PR-1", pr_detail: "PR-ROW-1" }]);
  });

  it("sets the PI posting-date flag and keeps stock updates disabled", async () => {
    const mode = modes[1]; const up = upstream(mode);
    await executeTransactionWrite(environment().env, props, mode.create, create(mode, { posting_date: "2025-01-10", due_date: "2025-02-10", bill_no: "BILL-1", bill_date: "2025-01-08" }));
    expect(up.savedBody()).toMatchObject({ posting_date: "2025-01-10", set_posting_time: 1, due_date: "2025-02-10", bill_no: "BILL-1", bill_date: "2025-01-08", update_stock: 0 });
  });

  it.each([{ update_stock: 1 }, { is_paid: 1 }, { is_return: 1 }])("rejects special PI drafts %j", async (patch) => {
    const mode = modes[1]; const up = upstream(mode); Object.assign(up.state.current, patch);
    await expect(executeTransactionWrite(environment().env, props, mode.update, update(mode, { bill_no: "BILL-1" }))).rejects.toThrow("ordinary unpaid");
    expect(up.saves()).toHaveLength(0);
  });
});

describe("Lead quotation to linked Customer Sales Order", () => {
  const mode = modes[0];
  function leadUpstream() {
    const up = upstream(mode);
    const src = up.state.sources.get(mode.sourceId)!;
    Object.assign(src, { modified, quotation_to: "Lead", party_name: "LEAD-1", transaction_date: "2025-01-10", valid_till: "2099-12-31",
      taxes: [{ charge_type: "On Net Total", account_head: "GST", rate: 15 }],
      apply_discount_on: "Net Total", additional_discount_percentage: 10, discount_amount: 10, conversion_rate: 1, plc_conversion_rate: 1 });
    src.items.forEach((row: Row) => Object.assign(row, { stock_qty: row.qty * 2, ordered_qty: 4, conversion_factor: 2,
      is_alternative: 0, has_alternative_item: 0, against_blanket_order: 0 }));
    const expiryLookup = { rows: [{ name: src.name, modified, valid_till: null }] as Row[] };
    up.state.before = (url) => {
      if (decodeURIComponent(url.pathname) === "/api/resource/Customer/CUST-1") return Response.json({ data: { name: "CUST-1", lead_name: "LEAD-1" } });
      if (url.pathname === "/api/resource/Quotation") return Response.json({ data: expiryLookup.rows });
      if (url.pathname === "/api/method/frappe.client.get_time_zone") return Response.json({ message: { time_zone: "UTC" } });
    };
    const mapperCalls = () => up.maps().filter(([url]) => url.includes("make_sales_order"));
    return { ...up, src, mapperCalls, expiryLookup };
  }

  it("creates and updates linked rows without calling the native Lead mapper or creating a Customer", async () => {
    const up = leadUpstream(); const ctx = environment();
    const result = await executeTransactionWrite(ctx.env, props, mode.create, create(mode, { items: [linked(mode, { qty: 3 })] }));
    expect(up.mapperCalls()).toHaveLength(0);
    expect(up.saves()).toHaveLength(1);
    expect(up.savedBody()).toMatchObject({ customer: "CUST-1", additional_discount_percentage: 10, apply_discount_on: "Net Total",
      taxes: [{ account_head: "GST", rate: 15 }], items: [{ qty: 3, rate: 12, conversion_factor: 2, prevdoc_docname: "QTN-1", quotation_item: "SOURCE-ROW-1" }] });
    expect(result.structuredContent.document).toMatchObject({ items: [{ quotation_item: "SOURCE-ROW-1" }], taxes: [{ rate: 15 }] });
    await executeTransactionWrite(ctx.env, props, mode.update, update(mode, { items: [{ name: "NEW-ROW-1", ...item, qty: 4 }] }));
    expect(up.savedBody().items[0]).toMatchObject({ name: "NEW-ROW-1", qty: 4, prevdoc_docname: "QTN-1", quotation_item: "SOURCE-ROW-1" });
    expect(up.mapperCalls()).toHaveLength(0);
    expect(up.saves().every(([url]) => url.includes("/Sales%20Order"))).toBe(true);
  });

  it("enforces available stock units and the total quantity of split references", async () => {
    const up = leadUpstream();
    up.src.items[0].stock_qty = 10; // (10 - 4) / 2 = 3 remaining units
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode, { qty: 2 }), linked(mode, { qty: 2 })] }))).rejects.toThrow("available source quantity");
    expect(up.saves()).toHaveLength(0); expect(up.mapperCalls()).toHaveLength(0);
  });

  it.each([undefined, null, -1, "10", Number.NaN])("refuses unreadable or invalid ordered quantities: %s", async (value) => {
    const up = leadUpstream(); up.src.items[0].ordered_qty = value;
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
    expect(up.saves()).toHaveLength(0); expect(up.mapperCalls()).toHaveLength(0);
  });

  it.each(["stock_qty", "conversion_factor", "rate", "is_alternative", "has_alternative_item", "against_blanket_order"]) ("refuses a hidden %s field", async (field) => {
    const up = leadUpstream(); delete up.src.items[0][field];
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
    expect(up.saves()).toHaveLength(0);
  });

  it.each(["currency", "conversion_rate", "plc_conversion_rate", "additional_discount_percentage", "discount_amount"])("refuses a hidden source %s field", async (field) => {
    const up = leadUpstream(); up.src.discount_amount = 0; delete up.src[field];
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
    expect(up.saves()).toHaveLength(0); expect(up.mapperCalls()).toHaveLength(0);
  });

  it.each([null, "2099-12-31"])("creates and updates with a confirmed omitted expiry %s without losing source links", async (valid_till) => {
    const up = leadUpstream(); delete up.src.valid_till; const ctx = environment();
    up.expiryLookup.rows[0].valid_till = valid_till;
    await executeTransactionWrite(ctx.env, props, mode.create, create(mode, { items: [linked(mode)] }));
    await executeTransactionWrite(ctx.env, props, mode.update, update(mode, { items: [{ name: "NEW-ROW-1", ...item, qty: 3 }] }));
    expect(up.savedBody().items[0]).toMatchObject({ name: "NEW-ROW-1", qty: 3, prevdoc_docname: "QTN-1", quotation_item: "SOURCE-ROW-1" });
    const lookups = up.mock.mock.calls.filter(([url]) => new URL(url).pathname === "/api/resource/Quotation");
    expect(lookups).toHaveLength(2);
    for (const [url, init] of lookups) {
      const query = new URL(url).searchParams;
      expect(query.get("fields")).toBe(JSON.stringify(["name", "modified", "valid_till"]));
      expect(JSON.parse(query.get("filters")!)).toEqual([["Quotation", "name", "=", "QTN-1"]]);
      expect(query.get("limit_page_length")).toBe("1");
      expect(init?.headers).toMatchObject({ Authorization: "token test-key:test-secret" });
    }
    expect(up.mapperCalls()).toHaveLength(0);
    expect(up.saves()).toHaveLength(2);
  });

  it.each([null, "", "2099-12-31"])("uses an explicit expiry %s without another lookup", async (valid_till) => {
    const up = leadUpstream(); up.src.valid_till = valid_till;
    await executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }));
    expect(up.mock.mock.calls.some(([url]) => new URL(url).pathname === "/api/resource/Quotation")).toBe(false);
    expect(up.saves()).toHaveLength(1);
  });

  it.each([
    [], [{ name: "OTHER", modified, valid_till: null }], [{ name: "QTN-1", modified }],
    [{ name: "QTN-1", valid_till: null }], [{ name: "QTN-1", modified: "", valid_till: null }],
    [{ name: "QTN-1", modified, valid_till: 0 }], [{ name: "QTN-1", modified, valid_till: {} }],
    [{ name: "QTN-1", modified, valid_till: null }, { name: "QTN-1", modified, valid_till: null }],
  ].map((rows) => ({ rows })))("rejects unreadable or invalid expiry lookup rows %j before reserving a write", async ({ rows }) => {
    const up = leadUpstream(); delete up.src.valid_till; up.expiryLookup.rows = rows; const ctx = environment();
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("expiry date could not be confirmed");
    expect(up.saves()).toHaveLength(0); expect(up.mapperCalls()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it("rejects a changed source snapshot before reserving a write", async () => {
    const up = leadUpstream(); delete up.src.valid_till; up.expiryLookup.rows[0].modified = "2025-01-11 12:00:00.000000"; const ctx = environment();
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("CONFLICT");
    expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it.each([undefined, ""])("rejects an unconfirmed source modification timestamp %s", async (value) => {
    const up = leadUpstream(); delete up.src.valid_till; up.src.modified = value; const ctx = environment();
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("expiry date could not be confirmed");
    expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it("keeps denied expiry reads as a permission failure", async () => {
    const up = leadUpstream(); delete up.src.valid_till; const before = up.state.before!; const ctx = environment();
    up.state.before = (url, init) => url.pathname === "/api/resource/Quotation" ? new Response("private field detail", { status: 403 }) : before(url, init);
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("PERMISSION_DENIED");
    expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it.each(["2020-01-01", "2026-02-30", "bad-date"])("validates a fetched expiry date %s", async (valid_till) => {
    const up = leadUpstream(); delete up.src.valid_till; up.expiryLookup.rows[0].valid_till = valid_till; const ctx = environment();
    await expect(executeTransactionWrite(ctx.env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("Expired or invalid Lead quotations");
    expect(up.saves()).toHaveLength(0); expect(ctx.reservations.size).toBe(0);
  });

  it.each([{ is_alternative: 1 }, { has_alternative_item: 1 }, { against_blanket_order: 1 }])("refuses unsupported source line settings %j", async (patch) => {
    const up = leadUpstream(); Object.assign(up.src.items[0], patch);
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("normal NexWave conversion");
    expect(up.saves()).toHaveLength(0); expect(up.mapperCalls()).toHaveLength(0);
  });

  it("preserves saved line margins instead of changing the offered price", async () => {
    const up = leadUpstream();
    Object.assign(up.src.items[0], { price_list_rate: 10, margin_type: "Amount", margin_rate_or_amount: 2, rate_with_margin: 12, base_rate_with_margin: 12 });
    const result = await executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }));
    expect(up.savedBody().items[0]).toMatchObject({ rate: 12, price_list_rate: 10, margin_type: "Amount", margin_rate_or_amount: 2, rate_with_margin: 12 });
    expect(result.structuredContent.document).toMatchObject({ items: [{ margin_type: "Amount", margin_rate_or_amount: 2 }] });
    expect(up.mapperCalls()).toHaveLength(0);
  });

  it.each([{ has_unit_price_items: 1 }, { referral_sales_partner: "PARTNER-1" }, { sales_team: [{ sales_person: "PERSON-1" }] }])("refuses unsupported source header settings %j", async (patch) => {
    const up = leadUpstream(); Object.assign(up.src, patch);
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("normal NexWave conversion");
    expect(up.saves()).toHaveLength(0); expect(up.mapperCalls()).toHaveLength(0);
  });

  it("requires the Customer link again when updating an existing linked order", async () => {
    const up = leadUpstream(); up.state.current.items = [{ name: "TARGET-ROW-1", ...linked(mode) }];
    const handler = up.state.before!;
    up.state.before = (url, init) => decodeURIComponent(url.pathname).includes("/Customer/") ? Response.json({ data: { name: "CUST-1", lead_name: "OTHER-LEAD" } }) : handler(url, init);
    await expect(executeTransactionWrite(environment().env, props, mode.update, update(mode, { delivery_date: "2025-02-01" }))).rejects.toThrow("exact lead_name");
    expect(up.saves()).toHaveLength(0); expect(up.mapperCalls()).toHaveLength(0);
  });

  it("stops on denied Customer access", async () => {
    const up = leadUpstream();
    up.state.before = (url) => decodeURIComponent(url.pathname).includes("/Customer/") ? new Response(null, { status: 403 }) : undefined;
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("PERMISSION_DENIED");
    expect(up.saves()).toHaveLength(0); expect(up.mapperCalls()).toHaveLength(0);
  });

  it("rejects expiry using the site date rather than UTC", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T11:30:00Z"));
    const up = leadUpstream(); up.src.valid_till = "2026-01-01";
    const handler = up.state.before!;
    up.state.before = (url, init) => url.pathname.endsWith("get_time_zone") ? Response.json({ message: { time_zone: "Pacific/Auckland" } }) : handler(url, init);
    await expect(executeTransactionWrite(environment().env, props, mode.create, create(mode, { items: [linked(mode)] }))).rejects.toThrow("Expired");
    expect(up.saves()).toHaveLength(0); expect(up.mapperCalls()).toHaveLength(0);
  });
});
