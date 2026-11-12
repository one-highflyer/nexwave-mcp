import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSubmission } from "../src/submission-writes";
import type { Env, NexWaveApiTokenAuthProps, WriteCapability } from "../src/types";

type Row = Record<string, unknown>;
type Target = "Quotation" | "Sales Order" | "Purchase Invoice";
const capabilities: WriteCapability[] = ["quotations", "sales_orders", "purchase_invoices", "submissions"];
const props: NexWaveApiTokenAuthProps = {
  authType: "api_token", siteId: "submission-test-site", siteName: "Example", baseUrl: "https://example.invalid",
  user: "user@example.invalid", upstreamApiKey: "test-key", upstreamApiSecret: "test-secret", writeCapabilities: capabilities,
};
const modified = "2025-01-10 12:00:00.000000";
const input = { doctype: "Quotation" as Target, name: "QTN-1", expected_modified: modified,
  request_key: "submit-test-1", confirm_submission: true as const };

afterEach(() => vi.unstubAllGlobals());

// Model uniqueness and state changes so tests check effects, rather than SQL wording.
function environment(configured: readonly string[] = capabilities) {
  const reservations = new Map<string, { fingerprint: string; state: string; document_name?: string }>();
  const site = { id: props.siteId, enabled: 1, base_url: props.baseUrl, auth_type: "api_token",
    write_capabilities: JSON.stringify(configured) };
  const controls = { failCompletion: false, failUnknownMarker: false, completionChanges: 1 };
  const prepare = (sql: string) => ({ bind(...values: unknown[]) {
    const query = sql.toLowerCase();
    const complete = query.includes("state = 'complete'");
    const key = JSON.stringify(complete ? values.slice(1, 5) : values.slice(0, 4));
    return {
      first: async () => query.includes("from sites") ? site : reservations.get(key) ?? null,
      run: async () => {
        if (query.startsWith("insert into write_requests")) {
          if (reservations.has(key)) return { meta: { changes: 0 } };
          reservations.set(key, { fingerprint: String(values[4]), state: "pending" });
        } else if (complete) {
          if (controls.failCompletion) throw new Error("completion store unavailable");
          if (controls.completionChanges !== 1) return { meta: { changes: controls.completionChanges } };
          Object.assign(reservations.get(key)!, { state: "complete", document_name: values[0] });
        } else if (query.includes("state = 'unknown'")) {
          if (controls.failUnknownMarker) throw new Error("outcome marker unavailable");
          Object.assign(reservations.get(key)!, { state: "unknown" });
        } else throw new Error("Unexpected reservation mutation");
        return { meta: { changes: 1 } };
      },
    };
  } });
  return { env: { NEXWAVE_MCP_DB: { prepare } } as unknown as Env, reservations, site, controls };
}

function backend(target: Target = "Quotation") {
  const state = { document: {
    doctype: target, name: "QTN-1", docstatus: 0, status: "Draft", modified, company: "Example Company",
    currency: "NZD", grand_total: 100, is_return: 0, update_stock: 0, is_paid: 0, paid_amount: 0,
    items: [{ name: "ROW-1", item_code: "ITEM-1", qty: 1, rate: 100,
      prevdoc_docname: "SOURCE-QTN-1", quotation_item: "SOURCE-QTN-ROW-1", purchase_order: "PO-1", po_detail: "PO-ROW-1",
      purchase_receipt: "RECEIPT-1", pr_detail: "RECEIPT-ROW-1", private_row_field: "private-row-value" },
    { name: "HIDDEN-ROW", private_row_field: "private-hidden-row" }],
    taxes: [], payment_schedule: [], private_header: "private-header-value",
  } as Row };
  const controls: {
    metadata: Row; read: ((value: Row) => Row) | undefined; mutation: ((value: Row) => Response | Promise<Response>) | undefined;
  } = { metadata: { doctype: "DocType", name: target, is_submittable: 1, __workflow_docs: [] }, read: undefined, mutation: undefined };
  const fetch = vi.fn(async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw));
    if (init?.method === "PUT") {
      if (controls.mutation) return controls.mutation(JSON.parse(String(init.body)));
      Object.assign(state.document, JSON.parse(String(init.body)), { modified: "2025-01-10 12:01:00.000000" });
      return Response.json({ data: controls.read ? controls.read(state.document) : state.document });
    }
    if (url.pathname === "/api/method/frappe.desk.form.load.getdoctype") return Response.json({ docs: [controls.metadata] });
    if (url.pathname.startsWith("/api/resource/")) return Response.json({ data: controls.read ? controls.read(state.document) : state.document });
    throw new Error("Unexpected upstream path");
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, state, controls, mutations: () => fetch.mock.calls.filter(([, init]) => init?.method === "PUT") };
}

describe("submission access and input boundary", () => {
  it.each([undefined, [], ["submissions"], ["quotations"]].map((granted) => ({ granted })))("requires both submission and document access: %j", async ({ granted }) => {
    const upstream = backend(); const ctx = environment();
    await expect(executeSubmission(ctx.env, { ...props, writeCapabilities: granted as WriteCapability[] | undefined }, input)).rejects.toThrow("PERMISSION_DENIED");
    expect(upstream.fetch).not.toHaveBeenCalled();
    expect(ctx.reservations.size).toBe(0);
  });

  it("requires the matching document capability", async () => {
    const upstream = backend("Sales Order"); const ctx = environment();
    await expect(executeSubmission(ctx.env, { ...props, writeCapabilities: ["submissions", "quotations"] }, { ...input, doctype: "Sales Order" })).rejects.toThrow("PERMISSION_DENIED");
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it.each([[], ["submissions"], ["quotations"]].map((configured) => ({ configured })))("rechecks both configured capabilities: %j", async ({ configured }) => {
    const upstream = backend(); const ctx = environment(configured);
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow("PERMISSION_DENIED");
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it.each(["disabled", "origin", "auth type"])("rejects a mismatched site: %s", async (reason) => {
    const upstream = backend(); const ctx = environment();
    if (reason === "disabled") ctx.site.enabled = 0;
    else if (reason === "origin") ctx.site.base_url = "https://other.invalid";
    else ctx.site.auth_type = "oauth";
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow("PERMISSION_DENIED");
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { doctype: "Customer" }, { doctype: "Sales Invoice" }, { confirm_submission: false }, { confirm_submission: undefined },
    { flags: { ignore_permissions: true } }, { items: [] }, { docstatus: 1 }, { workflow_action: "Approve" },
  ])("rejects unsupported or unconfirmed input %j", async (extra) => {
    const upstream = backend(); const ctx = environment();
    await expect(executeSubmission(ctx.env, props, { ...input, ...extra })).rejects.toThrow("INVALID_ARGUMENT");
    expect(upstream.fetch).not.toHaveBeenCalled();
    expect(ctx.reservations.size).toBe(0);
  });
});

describe("canonical document and workflow preconditions", () => {
  it.each([1, 2])("does not resubmit a document at state %s with a new key", async (docstatus) => {
    const upstream = backend(); const ctx = environment(); upstream.state.document.docstatus = docstatus;
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow();
    expect(upstream.mutations()).toHaveLength(0);
    expect(ctx.reservations.size).toBe(0);
  });

  it("rejects a stale expected modification before reserving the request", async () => {
    const upstream = backend(); const ctx = environment();
    await expect(executeSubmission(ctx.env, props, { ...input, expected_modified: "2025-01-09 12:00:00.000000" })).rejects.toThrow("CONFLICT");
    expect(upstream.mutations()).toHaveLength(0);
    expect(ctx.reservations.size).toBe(0);
  });

  it.each([{ name: "ANOTHER-DOCUMENT" }, { doctype: "Sales Order" }])("rejects an unexpected document identity %j", async (identity) => {
    const upstream = backend(); const ctx = environment(); Object.assign(upstream.state.document, identity);
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow();
    expect(upstream.mutations()).toHaveLength(0);
    expect(ctx.reservations.size).toBe(0);
  });

  it.each([{ is_return: 1 }, { update_stock: 1 }, { is_paid: 1 }, { paid_amount: 25 }, { is_return: undefined }])("rejects non-ordinary Purchase Invoices %j", async (values) => {
    const upstream = backend("Purchase Invoice"); const ctx = environment(); Object.assign(upstream.state.document, values);
    await expect(executeSubmission(ctx.env, props, { ...input, doctype: "Purchase Invoice" })).rejects.toThrow();
    expect(upstream.mutations()).toHaveLength(0);
    expect(ctx.reservations.size).toBe(0);
  });

  it("refuses workflow-controlled documents without changing a workflow state", async () => {
    const upstream = backend(); const ctx = environment();
    upstream.controls.metadata.__workflow_docs = [{ doctype: "Workflow", name: "Approval", is_active: 1 }];
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow(/workflow/i);
    expect(upstream.mutations()).toHaveLength(0);
    expect(ctx.reservations.size).toBe(0);
  });

  it.each([
    { __workflow_docs: undefined }, { __workflow_docs: "[]" }, { __workflow_docs: null },
    { is_submittable: 0 }, { name: "Customer" }, { doctype: "Customer" },
  ])("fails closed on incomplete or unexpected form metadata %j", async (values) => {
    const upstream = backend(); const ctx = environment(); Object.assign(upstream.controls.metadata, values);
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow();
    expect(upstream.mutations()).toHaveLength(0);
    expect(ctx.reservations.size).toBe(0);
  });

  it("refuses submission when workflow metadata cannot be read", async () => {
    const upstream = backend(); const ctx = environment(); const normal = upstream.fetch.getMockImplementation()!;
    upstream.fetch.mockImplementation((url, init) => String(url).includes("/api/method/")
      ? Promise.resolve(new Response("private workflow configuration", { status: 403 })) : normal(url, init));
    const submission = executeSubmission(ctx.env, props, input);
    await expect(submission).rejects.toThrow("PERMISSION_DENIED");
    await expect(submission).rejects.not.toThrow("private workflow");
    expect(upstream.mutations()).toHaveLength(0);
    expect(ctx.reservations.size).toBe(0);
  });
});

describe("one-shot native submission and retained source links", () => {
  it.each(["Quotation", "Sales Order", "Purchase Invoice"] as Target[])("submits %s with only native status and concurrency fields", async (doctype) => {
    const upstream = backend(doctype); const ctx = environment();
    const result = await executeSubmission(ctx.env, props, { ...input, doctype });
    const [[url, init]] = upstream.mutations();
    expect(url).toBe(`https://example.invalid/api/resource/${encodeURIComponent(doctype)}/QTN-1`);
    expect(JSON.parse(String(init?.body))).toEqual({ docstatus: 1, modified });
    expect(init?.headers).toMatchObject({ Authorization: "token test-key:test-secret" });
    expect(result.structuredContent).toMatchObject({ doctype, name: "QTN-1", replayed: false, document: { docstatus: 1, grand_total: 100 } });
    const [, metadataInit] = upstream.fetch.mock.calls.find(([path]) => String(path).includes("/api/method/"))!;
    expect(metadataInit?.method).not.toBe("POST");
    const metadataUrl = new URL(String(upstream.fetch.mock.calls.find(([path]) => String(path).includes("/api/method/"))![0]));
    expect(metadataUrl.pathname).toBe("/api/method/frappe.desk.form.load.getdoctype");
    expect(metadataUrl.searchParams.get("doctype")).toBe(doctype);
    expect(metadataUrl.searchParams.get("with_parent")).toBe("0");
    expect(metadataUrl.searchParams.has("cached_timestamp")).toBe(false);
    expect(upstream.fetch.mock.calls.some(([path]) => String(path).includes("/api/resource/Workflow"))).toBe(false);
    expect([...ctx.reservations.values()][0].state).toBe("complete");
  });

  it.each(["Sales Order", "Purchase Invoice"] as Target[])("keeps canonical hidden rows and returns visible %s source links", async (doctype) => {
    const upstream = backend(doctype); const ctx = environment();
    upstream.controls.read = (document) => {
      const { private_header: _private, ...visible } = document;
      return { ...visible, items: (document.items as Row[]).filter((row) => row.name !== "HIDDEN-ROW").map(({ private_row_field: _rowPrivate, ...row }) => row) };
    };
    const result = await executeSubmission(ctx.env, props, { ...input, doctype });
    expect(upstream.state.document.private_header).toBe("private-header-value");
    expect(upstream.state.document.items).toHaveLength(2);
    expect((upstream.state.document.items as Row[])[1].private_row_field).toBe("private-hidden-row");
    const document = result.structuredContent!.document as Row;
    expect((document.items as Row[])[0]).toMatchObject(doctype === "Sales Order"
      ? { name: "ROW-1", prevdoc_docname: "SOURCE-QTN-1", quotation_item: "SOURCE-QTN-ROW-1" }
      : { name: "ROW-1", purchase_order: "PO-1", po_detail: "PO-ROW-1", purchase_receipt: "RECEIPT-1", pr_detail: "RECEIPT-ROW-1" });
    expect(JSON.stringify(result)).not.toContain("private-");
  });
});

describe("submission replay and uncertain outcomes", () => {
  it("replays a completed key through a current read and never submits twice", async () => {
    const upstream = backend(); const ctx = environment();
    await executeSubmission(ctx.env, props, input);
    upstream.state.document.docstatus = 2;
    const replay = await executeSubmission(ctx.env, props, { ...input });
    expect(replay.structuredContent).toMatchObject({ replayed: true, document: { docstatus: 2 } });
    expect(upstream.mutations()).toHaveLength(1);
  });

  it("rejects reuse of a key for another document", async () => {
    const upstream = backend(); const ctx = environment();
    await executeSubmission(ctx.env, props, input);
    await expect(executeSubmission(ctx.env, props, { ...input, name: "QTN-2" })).rejects.toThrow("CONFLICT");
    expect(upstream.mutations()).toHaveLength(1);
  });

  it("rechecks revoked submission access even for a completed key", async () => {
    const upstream = backend(); const ctx = environment();
    await executeSubmission(ctx.env, props, input);
    const calls = upstream.fetch.mock.calls.length;
    ctx.site.write_capabilities = JSON.stringify(["quotations"]);
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow("PERMISSION_DENIED");
    expect(upstream.fetch).toHaveBeenCalledTimes(calls);
  });

  it("reserves concurrent identical calls so only one upstream submit can run", async () => {
    const upstream = backend(); const ctx = environment();
    const results = await Promise.allSettled([executeSubmission(ctx.env, props, input), executeSubmission(ctx.env, props, { ...input })]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(upstream.mutations()).toHaveLength(1);
    expect(ctx.reservations.size).toBe(1);
  });

  it.each(["transport", "server"])("does not retry a mutation with an uncertain %s failure", async (failure) => {
    const upstream = backend(); const ctx = environment();
    upstream.controls.mutation = () => {
      if (failure === "transport") throw new Error("connection lost after commit");
      return new Response("private server details", { status: 500 });
    };
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(upstream.mutations()).toHaveLength(1);
    expect([...ctx.reservations.values()][0].state).toBe("unknown");
  });

  it.each([{ name: "ANOTHER-DOCUMENT" }, { doctype: "Customer" }, { docstatus: 0 }])("does not confirm an unexpected submitted response %j", async (values) => {
    const upstream = backend(); const ctx = environment();
    upstream.controls.mutation = () => Response.json({ data: { ...upstream.state.document, docstatus: 1, ...values } });
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(upstream.mutations()).toHaveLength(1);
    expect([...ctx.reservations.values()][0].state).toBe("unknown");
  });

  it.each([[403, "PERMISSION_DENIED"], [401, "AUTHENTICATION_REQUIRED"], [417, "VALIDATION_FAILED"], [404, "NOT_FOUND"]] as const)("returns safe HTTP %s failures without retrying the submit", async (status, code) => {
    const upstream = backend(); const ctx = environment();
    upstream.controls.mutation = () => new Response("private account and document details", { status });
    const submission = executeSubmission(ctx.env, props, input);
    await expect(submission).rejects.toThrow(code);
    await expect(submission).rejects.not.toThrow("private account");
    expect(upstream.mutations()).toHaveLength(1);
  });

  it("reports uncertainty when the upstream commit cannot be stored as complete", async () => {
    const upstream = backend(); const ctx = environment(); ctx.controls.failCompletion = true;
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(upstream.state.document.docstatus).toBe(1);
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(upstream.mutations()).toHaveLength(1);
  });

  it("does not confirm submission when no reservation was marked complete", async () => {
    const upstream = backend(); const ctx = environment(); ctx.controls.completionChanges = 0;
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(upstream.state.document.docstatus).toBe(1);
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(upstream.mutations()).toHaveLength(1);
  });

  it("keeps a pending reservation protective when the unknown marker also fails", async () => {
    const upstream = backend(); const ctx = environment();
    ctx.controls.failCompletion = true; ctx.controls.failUnknownMarker = true;
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect([...ctx.reservations.values()][0].state).toBe("pending");
    await expect(executeSubmission(ctx.env, props, input)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(upstream.mutations()).toHaveLength(1);
  });
});
