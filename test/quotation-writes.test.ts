import { afterEach, describe, expect, it, vi } from "vitest";
import { executeWrite } from "../src/quotation-writes";
import { grantedWriteCapabilities, parseWriteCapabilities } from "../src/write-access";
import { refreshUpstreamOnTokenExchange } from "../src/auth";
import { GrantType, type TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import type { Env, NexWaveApiTokenAuthProps, NexWaveOAuthAuthProps } from "../src/types";

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  GrantType: { AUTHORIZATION_CODE: "authorization_code", REFRESH_TOKEN: "refresh_token" },
  AuthorizationError: class AuthorizationError extends Error {},
}));

const props: NexWaveApiTokenAuthProps = {
  authType: "api_token", siteId: "test-site", siteName: "Example", baseUrl: "https://example.invalid",
  user: "user@example.invalid", upstreamApiKey: "test-key", upstreamApiSecret: "test-secret", writeCapabilities: ["quotations", "leads", "customers"],
};
const create = { request_key: "test-create-1", company: "Example Company", quotation_to: "Customer", party_name: "CUST-1", transaction_date: "2025-01-10", items: [{ item_code: "ITEM-1", qty: 2 }] };
const draft = { name: "QTN-1", docstatus: 0, modified: "2025-01-10 12:00:00.000000", company: "Example Company", transaction_date: "2025-01-10", currency: "NZD", selling_price_list: "Retail", items: [{ item_code: "ITEM-1", qty: 2, rate: 15 }], grand_total: 34.5 };
afterEach(() => vi.unstubAllGlobals());

// Stateful reservation store models uniqueness; tests assert outbound effects, not SQL strings alone.
function environment(capabilities = '["quotations","leads","customers"]') {
  const reservations = new Map<string, { fingerprint: string; state: string; document_name?: string }>();
  const site = { id: props.siteId, enabled: 1, base_url: props.baseUrl, auth_type: "api_token", write_capabilities: capabilities };
  const prepare = (query: string) => ({ bind(...values: unknown[]) {
    const key = JSON.stringify(query.startsWith("UPDATE write_requests SET state = 'complete'") ? values.slice(1) : values.slice(0, 4));
    return {
      first: async () => query.includes("FROM sites") ? site : reservations.get(key) ?? null,
      run: async () => {
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
function upstream() {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" || init?.method === "PUT") return Response.json({ data: { ...draft, ...JSON.parse(String(init.body)), name: "QTN-1", grand_total: 34.5, private_field: "private" } });
    if (String(url).includes("/Quotation/")) return Response.json({ data: draft });
    return Response.json({ data: { name: "CUST-1" } });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("write access", () => {
  it("defaults legacy connections to read-only", async () => {
    const mock = upstream();
    await expect(executeWrite(environment().env, { ...props, writeCapabilities: undefined }, "create_draft_quotation", create)).rejects.toThrow("PERMISSION_DENIED");
    expect(mock).not.toHaveBeenCalled();
    expect(parseWriteCapabilities(undefined)).toEqual([]);
    expect(parseWriteCapabilities("malformed")).toEqual([]);
    expect(grantedWriteCapabilities(["nexwave:read"], '["quotations"]')).toEqual([]);
    expect(grantedWriteCapabilities(["nexwave:write:quotations", "nexwave:write:customers"], '["quotations"]')).toEqual(["quotations"]);
  });
  it("revokes site access before reaching Frappe even for an existing grant", async () => {
    const mock = upstream();
    await expect(executeWrite(environment("[]").env, props, "create_draft_quotation", create)).rejects.toThrow("PERMISSION_DENIED");
    expect(mock).not.toHaveBeenCalled();
  });
  it("does not reuse capabilities across origins or auth modes", async () => {
    const ctx = environment(); ctx.site.base_url = "https://another.invalid";
    await expect(executeWrite(ctx.env, props, "create_draft_quotation", create)).rejects.toThrow("PERMISSION_DENIED");
  });
  it("removes write capabilities when the token scope is narrowed", async () => {
    const oauth: NexWaveOAuthAuthProps = { ...props, authType: "oauth", upstreamAccessToken: "token", upstreamExpiresAt: Date.now() + 3600000, upstreamClientId: "client", upstreamClientSecret: "secret" };
    const result = await refreshUpstreamOnTokenExchange({ grantType: GrantType.AUTHORIZATION_CODE, props: oauth, requestedScope: ["nexwave:read"], scope: ["nexwave:read", "nexwave:write:quotations"] } as TokenExchangeCallbackOptions);
    expect(result?.accessTokenProps.writeCapabilities).toEqual([]);
    expect(oauth.writeCapabilities).toContain("quotations");
    const broad = await refreshUpstreamOnTokenExchange({ grantType: GrantType.AUTHORIZATION_CODE, props: oauth, requestedScope: ["nexwave:read", "nexwave:write:quotations"], scope: ["nexwave:read", "nexwave:write:quotations"] } as TokenExchangeCallbackOptions);
    expect(broad?.accessTokenProps.writeCapabilities).toEqual(["quotations"]);
  });
  it("keeps full grant capabilities when refreshing a narrow access token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ access_token: "fresh", expires_in: 3600 })));
    const oauth: NexWaveOAuthAuthProps = { siteId: props.siteId, siteName: props.siteName, baseUrl: props.baseUrl, user: props.user, authType: "oauth", writeCapabilities: ["quotations"], upstreamAccessToken: "token", upstreamRefreshToken: "refresh", upstreamExpiresAt: 0, upstreamClientId: "client", upstreamClientSecret: "secret" };
    const result = await refreshUpstreamOnTokenExchange({ grantType: GrantType.REFRESH_TOKEN, props: oauth, requestedScope: ["nexwave:read"], scope: ["nexwave:read", "nexwave:write:quotations"] } as TokenExchangeCallbackOptions);
    expect(result?.accessTokenProps.writeCapabilities).toEqual([]);
    expect(result?.newProps.writeCapabilities).toEqual(["quotations"]);
  });
});

describe("draft quotation writes", () => {
  it("uses one standard Frappe save with server-owned draft status and returns saved totals", async () => {
    const mock = upstream();
    const result = await executeWrite(environment().env, props, "create_draft_quotation", create);
    const mutation = mock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(mutation[0]).toBe("https://example.invalid/api/resource/Quotation");
    expect(mutation[1]?.headers).toMatchObject({ Authorization: "token test-key:test-secret" });
    const body = JSON.parse(String(mutation[1]?.body));
    expect(body).toMatchObject({ company: "Example Company", docstatus: 0, doctype: "Quotation", items: [{ item_code: "ITEM-1", qty: 2 }] });
    expect(body).not.toHaveProperty("request_key");
    expect(body.items[0]).not.toHaveProperty("rate");
    expect(result.structuredContent.document).toMatchObject({ docstatus: 0, grand_total: 34.5 });
    expect(JSON.stringify(result)).not.toContain("private_field");
  });
  it.each([{ docstatus: 1 }, { flags: { ignore_permissions: true } }, { custom_field: "unsafe" }])("rejects arbitrary or status fields %j", async (extra) => {
    const mock = upstream();
    await expect(executeWrite(environment().env, props, "create_draft_quotation", { ...create, ...extra })).rejects.toThrow("INVALID_ARGUMENT");
    expect(mock).not.toHaveBeenCalled();
  });
  it("rejects invalid dates and excess rows before any write", async () => {
    const mock = upstream();
    await expect(executeWrite(environment().env, props, "create_draft_quotation", { ...create, transaction_date: "2025-02-30" })).rejects.toThrow("INVALID_ARGUMENT");
    await expect(executeWrite(environment().env, props, "create_draft_quotation", { ...create, items: Array(51).fill(create.items[0]) })).rejects.toThrow("INVALID_ARGUMENT");
    expect(mock).not.toHaveBeenCalled();
  });
  it("replays a completed request by reading its result, never inserting twice", async () => {
    const mock = upstream(); const ctx = environment();
    await executeWrite(ctx.env, props, "create_draft_quotation", create);
    const second = await executeWrite(ctx.env, props, "create_draft_quotation", { ...create });
    expect(second.structuredContent.replayed).toBe(true);
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await expect(executeWrite(ctx.env, props, "create_draft_quotation", { ...create, party_name: "CUST-2" })).rejects.toThrow("CONFLICT");
  });
  it("reserves concurrent identical requests atomically", async () => {
    const mock = upstream(); const ctx = environment();
    const results = await Promise.allSettled([executeWrite(ctx.env, props, "create_draft_quotation", create), executeWrite(ctx.env, props, "create_draft_quotation", create)]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("does not automatically retry an uncertain mutation or allow the same key to insert again", async () => {
    const mock = upstream();
    mock.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") throw new Error("network lost after commit");
      return Response.json({ data: { name: "CUST-1" } });
    });
    const ctx = environment();
    await expect(executeWrite(ctx.env, props, "create_draft_quotation", create)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    await expect(executeWrite(ctx.env, props, "create_draft_quotation", create)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect([...ctx.reservations.values()][0].state).toBe("unknown");
  });
  it("returns safe upstream permission and validation errors without retries", async () => {
    const mock = upstream();
    mock.mockImplementation(async (_url, init) => init?.method === "POST" ? new Response("private details", { status: 403 }) : Response.json({ data: { name: "CUST-1" } }));
    const promise = executeWrite(environment().env, props, "create_draft_quotation", create);
    await expect(promise).rejects.toThrow("PERMISSION_DENIED");
    await expect(promise).rejects.not.toThrow("private details");
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it.each([1, 2])("rejects an existing quotation at docstatus %s", async (docstatus) => {
    const mock = upstream().mockImplementation(async () => Response.json({ data: { ...draft, docstatus } }));
    await expect(executeWrite(environment().env, props, "update_draft_quotation", { request_key: "test-update-1", name: draft.name, expected_modified: draft.modified, valid_till: "2025-02-01" })).rejects.toThrow("Only draft");
    expect(mock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it("rejects a stale draft without overwriting it", async () => {
    const mock = upstream();
    await expect(executeWrite(environment().env, props, "update_draft_quotation", { request_key: "test-update-1", name: draft.name, expected_modified: "old", valid_till: "2025-02-01" })).rejects.toThrow("CONFLICT");
    expect(mock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it("preserves the concurrency timestamp and resets inherited currency/payment values on a repricing update", async () => {
    const mock = upstream();
    await executeWrite(environment().env, props, "update_draft_quotation", { request_key: "test-update-1", name: draft.name, expected_modified: draft.modified, currency: "USD", transaction_date: "2025-01-15", items: create.items });
    const [, init] = mock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ modified: draft.modified, docstatus: 0, currency: "USD", conversion_rate: 0, plc_conversion_rate: 0, price_list_currency: "", payment_schedule: [], items: create.items });
  });
  it("requires fresh items when the pricing context changes", async () => {
    upstream();
    await expect(executeWrite(environment().env, props, "update_draft_quotation", { request_key: "test-update-1", name: draft.name, expected_modified: draft.modified, selling_price_list: "Wholesale" })).rejects.toThrow("Supply all items");
  });
  it("keeps a racing save failure safe and does not retry a rejected mutation", async () => {
    const mock = upstream().mockImplementation(async (_url, init) => init?.method === "PUT"
      ? new Response("private timestamp and account details", { status: 417 }) : Response.json({ data: draft }));
    const request = executeWrite(environment().env, props, "update_draft_quotation", { request_key: "test-racing-save", name: draft.name, expected_modified: draft.modified, valid_till: "2025-03-01" });
    await expect(request).rejects.toThrow("VALIDATION_FAILED");
    await expect(request).rejects.not.toThrow("private timestamp");
    expect(mock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
  it("clears the payment schedule when its template changes", async () => {
    const mock = upstream();
    await executeWrite(environment().env, props, "update_draft_quotation", { request_key: "test-payment-change", name: draft.name, expected_modified: draft.modified, payment_terms_template: "Net 30" });
    expect(JSON.parse(String(mock.mock.calls.find(([, init]) => init?.method === "PUT")![1]?.body))).toMatchObject({ payment_terms_template: "Net 30", payment_schedule: [] });
  });
  it("leaves terms empty for native contextual template rendering", async () => {
    const mock = upstream().mockImplementation(async (url, init) => {
      if (init?.method === "PUT") return Response.json({ data: { ...draft, ...JSON.parse(String(init.body)) } });
      if (url.includes("Terms%20and%20Conditions")) return Response.json({ data: { name: "Terms", selling: 1, disabled: 0, terms: "Offer for {{ customer_name }}" } });
      return Response.json({ data: draft });
    });
    await executeWrite(environment().env, props, "update_draft_quotation", { request_key: "test-terms-change", name: draft.name, expected_modified: draft.modified, tc_name: "Terms" });
    expect(JSON.parse(String(mock.mock.calls.find(([, init]) => init?.method === "PUT")![1]?.body))).toMatchObject({ tc_name: "Terms", terms: "" });
  });
  it("marks expanded saved/replayed quotation rows as a partial result", async () => {
    const mock = upstream();
    mock.mockImplementation(async (_url, init) => init?.method === "POST"
      ? Response.json({ data: { ...draft, items: Array.from({ length: 51 }, () => ({ item_code: "ITEM-1", qty: 1, rate: 10 })) } })
      : Response.json({ data: { name: "CUST-1" } }));
    const result = await executeWrite(environment().env, props, "create_draft_quotation", create);
    expect(result.structuredContent).toMatchObject({ document: { detail_meta: { items: { count: 51, next_offset: 50, complete: false } } } });
  });
  it("replaces tax rows from a readable template for the same company", async () => {
    const mock = upstream().mockImplementation(async (url, init) => {
      if (init?.method === "PUT") return Response.json({ data: { ...draft, ...JSON.parse(String(init.body)) } });
      if (url.includes("Sales%20Taxes")) return Response.json({ data: { company: draft.company, disabled: 0, taxes: [{ charge_type: "On Net Total", account_head: "GST", rate: 15, private_field: "private" }] } });
      return Response.json({ data: draft });
    });
    await executeWrite(environment().env, props, "update_draft_quotation", { request_key: "test-update-1", name: draft.name, expected_modified: draft.modified, taxes_and_charges: "GST 15" });
    const [, init] = mock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(init?.body)).taxes).toEqual([{ charge_type: "On Net Total", account_head: "GST", rate: 15 }]);
  });

  it.each(["create_draft_quotation", "update_draft_quotation"] as const)("copies an explicitly selected non-default Contact for %s", async (operation) => {
    const mock = upstream().mockImplementation(async (url, init) => {
      if (init?.method === "POST" || init?.method === "PUT") return Response.json({ data: { ...draft, ...JSON.parse(String(init.body)) } });
      if (url.includes("/Contact/")) return Response.json({ data: { name: "CONTACT-B", full_name: "Selected Buyer", email_id: "selected@example.invalid", mobile_no: "+640000002" } });
      return Response.json({ data: { ...draft, contact_person: "CONTACT-A", contact_display: "Old Buyer", contact_email: "old@example.invalid", contact_mobile: "+640000001" } });
    });
    const input = operation === "create_draft_quotation" ? { ...create, contact_person: "CONTACT-B" }
      : { request_key: "test-contact-change", name: draft.name, expected_modified: draft.modified, contact_person: "CONTACT-B" };
    const result = await executeWrite(environment().env, props, operation, input);
    const [, init] = mock.mock.calls.find(([, init]) => init?.method === "POST" || init?.method === "PUT")!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ contact_person: "CONTACT-B", contact_display: "Selected Buyer", contact_email: "selected@example.invalid", contact_mobile: "+640000002" });
    expect(result.structuredContent).toMatchObject({ document: { contact_person: "CONTACT-B", contact_display: "Selected Buyer", contact_email: "selected@example.invalid", contact_mobile: "+640000002" } });
  });

  it("clears missing selected-contact data instead of borrowing the default Contact's values", async () => {
    const mock = upstream().mockImplementation(async (url, init) => {
      if (init?.method === "PUT") return Response.json({ data: { ...draft, ...JSON.parse(String(init.body)) } });
      if (url.includes("/Contact/")) return Response.json({ data: { name: "CONTACT-B", full_name: "Selected Buyer", email_id: null } });
      return Response.json({ data: { ...draft, contact_email: "old@example.invalid", contact_mobile: "+640000001" } });
    });
    await executeWrite(environment().env, props, "update_draft_quotation", { request_key: "test-contact-empty", name: draft.name, expected_modified: draft.modified, contact_person: "CONTACT-B" });
    const [, init] = mock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ contact_display: "Selected Buyer", contact_email: "", contact_mobile: "" });
  });

  it.each(["Customer", "Lead"] as const)("renders explicitly selected %s addresses through the fixed native formatter", async (quotation_to) => {
    const mock = upstream().mockImplementation(async (input, init) => {
      const url = new URL(input);
      if (init?.method === "POST") return Response.json({ data: { ...draft, ...JSON.parse(String(init.body)) } });
      if (url.pathname.endsWith("get_address_display")) return Response.json({ message: `<p>${url.searchParams.get("address_dict")} native display</p>` });
      if (url.pathname.includes("/Address/")) return Response.json({ data: { name: decodeURIComponent(url.pathname.split("/").at(-1)!) } });
      return Response.json({ data: { name: "CUST-1" } });
    });
    const result = await executeWrite(environment().env, props, "create_draft_quotation", { ...create, quotation_to, customer_address: "BILLING-B", shipping_address_name: "SHIPPING-B" });
    expect(result.structuredContent).toMatchObject({ document: { customer_address: "BILLING-B", address_display: "<p>BILLING-B native display</p>", shipping_address_name: "SHIPPING-B", shipping_address: "<p>SHIPPING-B native display</p>" } });
    const formatterCalls = mock.mock.calls.filter(([input]) => input.includes("get_address_display"));
    expect(formatterCalls).toHaveLength(2);
    for (const [input, init] of formatterCalls) {
      expect(new URL(input).pathname).toBe("/api/method/frappe.contacts.doctype.address.address.get_address_display");
      expect(init?.headers).toMatchObject({ Authorization: "token test-key:test-secret" });
    }
  });

  it("replaces old address displays when their links change on a draft", async () => {
    const mock = upstream().mockImplementation(async (input, init) => {
      const url = new URL(input);
      if (init?.method === "PUT") return Response.json({ data: { ...draft, ...JSON.parse(String(init.body)) } });
      if (url.pathname.endsWith("get_address_display")) return Response.json({ message: `Rendered ${url.searchParams.get("address_dict")}` });
      if (url.pathname.includes("/Address/")) return Response.json({ data: { name: "ADDRESS-B" } });
      return Response.json({ data: { ...draft, customer_address: "ADDRESS-A", address_display: "Old billing", shipping_address_name: "ADDRESS-A", shipping_address: "Old shipping" } });
    });
    await executeWrite(environment().env, props, "update_draft_quotation", { request_key: "test-address-change", name: draft.name, expected_modified: draft.modified, customer_address: "ADDRESS-B", shipping_address_name: "ADDRESS-B" });
    const [, init] = mock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ address_display: "Rendered ADDRESS-B", shipping_address: "Rendered ADDRESS-B" });
  });

  it.each(["contact_person", "customer_address"] as const)("rejects a denied %s read before reserving or writing", async (field) => {
    const mock = upstream().mockImplementation(async (url) => url.includes("/Contact/") || url.includes("/Address/")
      ? new Response("private contact/address data", { status: 403 }) : Response.json({ data: { name: "CUST-1" } }));
    const ctx = environment();
    const result = executeWrite(ctx.env, props, "create_draft_quotation", { ...create, [field]: "PRIVATE-1" });
    await expect(result).rejects.toThrow("PERMISSION_DENIED");
    await expect(result).rejects.not.toThrow("private contact/address data");
    expect(ctx.reservations.size).toBe(0);
    expect(mock.mock.calls.some(([, init]) => init?.method === "POST" || init?.method === "PUT")).toBe(false);
  });
});

describe("party creation", () => {
  it("rejects a matching party before reserving or writing", async () => {
    const mock = upstream().mockResolvedValue(Response.json({ data: [{ name: "CUST-EXISTING", customer_name: "Example" }] }));
    const ctx = environment();
    await expect(executeWrite(ctx.env, props, "create_customer", { request_key: "test-customer-1", customer_name: "Example" })).rejects.toThrow("CONFLICT");
    expect(ctx.reservations.size).toBe(0);
    expect(mock).toHaveBeenCalledOnce();
  });
  it.each([
    ["create_customer", { customer_name: "Example", customer_group: "Commercial", territory: "New Zealand" }, "Customer"],
    ["create_lead", { first_name: "Example", email_id: "lead@example.invalid" }, "Lead"],
  ] as const)("saves an allowed %s through standard permissions", async (operation, fields, doctype) => {
    const mock = upstream().mockImplementation(async (_url, init) => init?.method === "POST"
      ? Response.json({ data: { ...JSON.parse(String(init.body)), name: "PARTY-NEW", docstatus: 0 } }) : Response.json({ data: [] }));
    const result = await executeWrite(environment().env, props, operation, { request_key: "test-party-new", ...fields });
    expect(result.structuredContent).toMatchObject({ doctype, name: "PARTY-NEW", replayed: false });
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});

describe("Customer CRM links", () => {
  const customer = { request_key: "test-linked-customer", customer_name: "Example Linked Customer", lead_name: "LEAD-1" };
  function sourceUpstream(options: {
    lead?: Record<string, unknown>;
    prospect?: Record<string, unknown>;
    prospects?: string[];
    existingCustomer?: boolean;
    savedLinks?: Record<string, unknown>;
  } = {}) {
    let saved: Record<string, unknown>;
    const mock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const route = decodeURIComponent(url.pathname);
      if (init?.method === "POST") {
        saved = { ...JSON.parse(String(init.body)), name: "CUST-LINKED", docstatus: 0,
          customer_primary_contact: "CONTACT-1", private_field: "not returned", ...options.savedLinks };
        return Response.json({ data: saved });
      }
      if (route === "/api/resource/Customer/CUST-LINKED") return Response.json({ data: saved });
      if (route === "/api/resource/Customer") {
        const filters = JSON.parse(url.searchParams.get("filters") ?? "[]");
        return Response.json({ data: options.existingCustomer && filters.some((row: unknown[]) => row[1] === "lead_name") ? [{ name: "CUST-EXISTING" }] : [] });
      }
      if (route === "/api/resource/Lead/LEAD-1") return Response.json({ data: { name: "LEAD-1", doctype: "Lead", status: "Open", disabled: 0, ...options.lead } });
      if (route === "/api/resource/Prospect") return Response.json({ data: (options.prospects ?? ["PROSPECT-1"]).map((name) => ({ name })) });
      if (route === "/api/resource/Prospect/PROSPECT-1") return Response.json({ data: { name: "PROSPECT-1", doctype: "Prospect", leads: [{ lead: "LEAD-1" }], ...options.prospect } });
      throw new Error(`Unexpected test route: ${route}`);
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("retains exact native Lead and Prospect links through one Customer insert and a replay", async () => {
    const mock = sourceUpstream();
    const ctx = environment();
    const result = await executeWrite(ctx.env, props, "create_customer", customer);
    expect(result.structuredContent).toMatchObject({ document: { lead_name: "LEAD-1", prospect_name: "PROSPECT-1", customer_primary_contact: "CONTACT-1" } });
    expect(result.structuredContent.document).not.toHaveProperty("private_field");
    const [, init] = mock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ lead_name: "LEAD-1", prospect_name: "PROSPECT-1", customer_name: customer.customer_name });
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(mock.mock.calls.every(([, init]) => init?.method !== "PUT")).toBe(true);
    const discovery = mock.mock.calls.map(([input]) => new URL(input)).find((url) => decodeURIComponent(url.pathname) === "/api/resource/Prospect")!;
    expect(JSON.parse(discovery.searchParams.get("filters")!)).toEqual([["Prospect Lead", "lead", "=", "LEAD-1"]]);
    expect(discovery.searchParams.get("limit_page_length")).toBe("3");
    mock.mockClear();
    const replay = await executeWrite(ctx.env, props, "create_customer", customer);
    expect(replay.structuredContent).toMatchObject({ replayed: true, document: { lead_name: "LEAD-1", prospect_name: "PROSPECT-1" } });
    expect(mock).toHaveBeenCalledOnce();
    expect(mock.mock.calls[0][0]).toContain("/Customer/CUST-LINKED");
  });

  it("deduplicates a repeated visible Prospect match without guessing a different source", async () => {
    sourceUpstream({ prospects: ["PROSPECT-1", "PROSPECT-1"] });
    const result = await executeWrite(environment().env, props, "create_customer", customer);
    expect(result.structuredContent).toMatchObject({ document: { prospect_name: "PROSPECT-1" } });
  });

  it("allows a Lead without a linked Prospect", async () => {
    const mock = sourceUpstream({ prospects: [] });
    const result = await executeWrite(environment().env, props, "create_customer", customer);
    expect(result.structuredContent).toMatchObject({ document: { lead_name: "LEAD-1" } });
    const [, init] = mock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("prospect_name");
  });

  it("keeps a Prospect-only request without choosing or converting one of its Leads", async () => {
    const mock = sourceUpstream({ prospect: { leads: [{ lead: "LEAD-1" }, { lead: "LEAD-2" }] } });
    const result = await executeWrite(environment().env, props, "create_customer", {
      request_key: "test-prospect-customer", customer_name: "Example Prospect Customer", prospect_name: "PROSPECT-1",
    });
    expect(result.structuredContent).toMatchObject({ document: { prospect_name: "PROSPECT-1" } });
    const [, init] = mock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("lead_name");
    expect(mock.mock.calls.some(([input]) => input.includes("/Lead/"))).toBe(false);
  });

  it("accepts an explicitly confirmed Lead and Prospect without an automatic lookup", async () => {
    const mock = sourceUpstream();
    await executeWrite(environment().env, props, "create_customer", { ...customer, prospect_name: "PROSPECT-1" });
    expect(mock.mock.calls.some(([input]) => new URL(input).pathname === "/api/resource/Prospect")).toBe(false);
  });

  it.each([
    ["multiple matches", ["PROSPECT-1", "PROSPECT-2"]],
    ["a full duplicate candidate page", ["PROSPECT-1", "PROSPECT-1", "PROSPECT-1"]],
  ])("requires explicit confirmation for %s", async (_label, prospects) => {
    const mock = sourceUpstream({ prospects });
    const ctx = environment();
    await expect(executeWrite(ctx.env, props, "create_customer", customer)).rejects.toThrow("CONFLICT");
    expect(ctx.reservations.size).toBe(0);
    expect(mock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it.each([
    ["another Lead", { leads: [{ lead: "LEAD-2" }] }, "INVALID_ARGUMENT"],
    ["an empty membership list", { leads: [] }, "INVALID_ARGUMENT"],
    ["missing membership details", { leads: undefined }, "UPSTREAM_INVALID_RESPONSE"],
    ["hidden Lead IDs", { leads: [{}] }, "UPSTREAM_INVALID_RESPONSE"],
    ["a different source record", { name: "PROSPECT-OTHER" }, "UPSTREAM_INVALID_RESPONSE"],
  ])("rejects %s before reserving or writing", async (_label, prospect, code) => {
    const mock = sourceUpstream({ prospect });
    const ctx = environment();
    await expect(executeWrite(ctx.env, props, "create_customer", { ...customer, prospect_name: "PROSPECT-1" })).rejects.toThrow(code);
    expect(ctx.reservations.size).toBe(0);
    expect(mock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it.each([
    [{ existingCustomer: true }, "CONFLICT"],
    [{ lead: { status: "Converted" } }, "CONFLICT"],
    [{ lead: { disabled: 1 } }, "INVALID_ARGUMENT"],
    [{ lead: { name: "LEAD-OTHER" } }, "UPSTREAM_INVALID_RESPONSE"],
  ])("rejects an existing, converted, disabled, or unexpected Lead", async (options, code) => {
    const mock = sourceUpstream(options);
    const ctx = environment();
    await expect(executeWrite(ctx.env, props, "create_customer", customer)).rejects.toThrow(code);
    expect(ctx.reservations.size).toBe(0);
    expect(mock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it.each([["Lead", 403], ["Lead", 404], ["Prospect", 403], ["Prospect", 404]] as const)("preserves an inaccessible or missing %s source (%s) without leaking response content", async (doctype, status) => {
    const mock = sourceUpstream();
    const original = mock.getMockImplementation()!;
    mock.mockImplementation(async (input, init) => input.includes(`/${doctype}/`)
      ? new Response("private source response", { status }) : original(input, init));
    const ctx = environment();
    const pending = executeWrite(ctx.env, props, "create_customer", customer);
    await expect(pending).rejects.toThrow(status === 403 ? "PERMISSION_DENIED" : "NOT_FOUND");
    await expect(pending).rejects.not.toThrow("private source response");
    expect(ctx.reservations.size).toBe(0);
  });

  it("checks Customer write access before reading the selected sources", async () => {
    const mock = sourceUpstream();
    await expect(executeWrite(environment("[]").env, props, "create_customer", customer)).rejects.toThrow("PERMISSION_DENIED");
    expect(mock).not.toHaveBeenCalled();
  });

  it("does not report success if the saved Customer drops or changes a requested source link", async () => {
    const mock = sourceUpstream({ savedLinks: { prospect_name: "PROSPECT-OTHER" } });
    const ctx = environment();
    await expect(executeWrite(ctx.env, props, "create_customer", customer)).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect([...ctx.reservations.values()][0].state).toBe("unknown");
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
