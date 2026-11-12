import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerQuotationLookups } from "../src/quotation-lookups";
import type { NexWaveAuthProps } from "../src/types";

type Result = { content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown> };
const registrations = vi.hoisted(() => new Map<string, {
  shape: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<Result>;
}>());

vi.mock("../src/tool-contract", () => ({
  registerReadTool: (_server: unknown, name: string, config: { inputSchema: Record<string, unknown> }, handler: (input: Record<string, unknown>) => Promise<Result>) => {
    registrations.set(name, { shape: config.inputSchema, handler });
  },
}));

const props: NexWaveAuthProps = {
  authType: "api_token", siteId: "test-site", siteName: "Test Site", baseUrl: "https://erp.example.com",
  user: "test@example.com", upstreamApiKey: "test-key", upstreamApiSecret: "test-secret",
};
const currentProps = vi.fn(async () => props);

beforeEach(() => {
  currentProps.mockClear();
  registrations.clear();
  registerQuotationLookups({} as McpServer, currentProps);
});
afterEach(() => vi.unstubAllGlobals());

describe("quotation lookup tools", () => {
  it("filters saved prices by exact party, currency, units, side, and open-ended validity", async () => {
    const fetchMock = vi.fn(async (_input: string) => Response.json({ data: [{ name: "PRICE-001", price_list_rate: 12 }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await invoke("list_item_prices", {
      item_code: "ITEM-001", price_list: "Retail", customer: "CUS-001", selling: true, buying: false,
      currency: "NZD", uom: "Box", valid_on: "2026-06-30", offset: 20,
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(decodeURIComponent(url.pathname)).toBe("/api/resource/Item Price");
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual(expect.arrayContaining([
      ["Item Price", "item_code", "=", "ITEM-001"], ["Item Price", "price_list", "=", "Retail"],
      ["Item Price", "customer", "=", "CUS-001"], ["Item Price", "currency", "=", "NZD"],
      ["Item Price", "uom", "=", "Box"], ["Item Price", "selling", "=", 1], ["Item Price", "buying", "=", 0],
      ["Item Price", "valid_from", "<=", "2026-06-30"],
    ]));
    expect(JSON.parse(url.searchParams.get("or_filters")!)).toEqual([
      ["Item Price", "valid_upto", ">=", "2026-06-30"], ["Item Price", "valid_upto", "is", "not set"],
    ]);
    expect(url.searchParams.get("limit_start")).toBe("20");
    expect(url.searchParams.get("order_by")).toBe("valid_from desc, name asc");
    expect(result.structuredContent).toMatchObject({ records: [{ name: "PRICE-001" }], meta: { complete: false, offset: 20 } });
    expect(result.content[1].text).toContain("Pricing Rules");
  });

  it("allows supplier prices and both buying and selling flags without inventing party fallback", async () => {
    const fetchMock = vi.fn(async (_input: string) => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await invoke("list_item_prices", { supplier: "SUP-001", buying: true, selling: true });
    const filters = JSON.parse(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("filters")!);
    expect(filters).toEqual([["Item Price", "supplier", "=", "SUP-001"], ["Item Price", "buying", "=", 1], ["Item Price", "selling", "=", 1]]);
  });

  it("keeps a full price page explicitly incomplete and supplies the next offset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ name: "PRICE-001" }, { name: "PRICE-002" }] })));
    const result = await invoke("list_item_prices", { limit: 2, offset: 4 });
    expect(result.structuredContent.meta).toMatchObject({ count: 2, offset: 4, limit: 2, complete: false, truncated: true, next_offset: 6 });
  });

  it.each([
    ["list_item_prices", { valid_on: "2026-02-30" }],
    ["list_quotations", { party_name: "CUS-001" }],
    ["list_quotations", { from_date: "2026-06-30", to_date: "2026-06-01" }],
    ["list_quotations", { to_date: "2026-02-30" }],
    ["list_prospects", { lead_name: "LEAD-1", summary: "count" }],
  ])("rejects invalid %s filters before authentication or upstream requests", async (tool, input) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(invoke(tool, input)).rejects.toThrow("INVALID_ARGUMENT");
    expect(currentProps).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists dual-purpose price lists with independent flags and the explicit enabled filter", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await invoke("list_price_lists", { buying: true, selling: true, currency: "NZD", enabled: false });
    expect(query(fetchMock).filters).toEqual(expect.arrayContaining([
      ["Price List", "enabled", "=", 0], ["Price List", "selling", "=", 1], ["Price List", "buying", "=", 1], ["Price List", "currency", "=", "NZD"],
    ]));
  });

  it("keeps lead email and active-status filters on a permission-aware list request", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await invoke("list_leads", { email_id: "prospect@example.com", status: "Open" });
    expect(query(fetchMock).filters).toEqual(expect.arrayContaining([
      ["Lead", "email_id", "=", "prospect@example.com"], ["Lead", "status", "=", "Open"], ["Lead", "disabled", "=", 0],
    ]));
  });

  it("finds Prospects by exact native Lead membership without inventing a Lead field on the parent", async () => {
    const fetchMock = vi.fn(async (_input: string) => Response.json({ data: [{ name: "PROSPECT-1", company_name: "Example Prospect" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await invoke("list_prospects", { lead_name: "LEAD-1", company: "Example Company", customer_group: "Commercial", territory: "Example Territory" });
    expect(decodeURIComponent(new URL(String(fetchMock.mock.calls[0][0])).pathname)).toBe("/api/resource/Prospect");
    expect(query(fetchMock).filters).toEqual(expect.arrayContaining([
      ["Prospect Lead", "lead", "=", "LEAD-1"], ["Prospect", "company", "=", "Example Company"],
      ["Prospect", "customer_group", "=", "Commercial"], ["Prospect", "territory", "=", "Example Territory"],
    ]));
    expect(query(fetchMock).fields).not.toContain("lead_name");
    expect(query(fetchMock).fields).not.toContain("disabled");
    expect(result.structuredContent).toMatchObject({ records: [{ name: "PROSPECT-1" }] });
  });

  it("filters quotations by the exact party type and transaction date", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await invoke("list_quotations", { quotation_to: "Lead", party_name: "LEAD-001", company: "Example Company", docstatus: 0, from_date: "2026-06-01", to_date: "2026-06-30" });
    expect(query(fetchMock).filters).toEqual(expect.arrayContaining([
      ["Quotation", "quotation_to", "=", "Lead"], ["Quotation", "party_name", "=", "LEAD-001"], ["Quotation", "company", "=", "Example Company"],
      ["Quotation", "docstatus", "=", 0], ["Quotation", "transaction_date", ">=", "2026-06-01"], ["Quotation", "transaction_date", "<=", "2026-06-30"],
    ]));
    expect(query(fetchMock).fields).not.toContain("terms");
  });

  it.each(["Sales", "Purchase"])("limits %s tax template lookup to the company and enabled templates", async (type) => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await invoke("list_tax_templates", { type, company: "Example Company", tax_category: "Standard" });
    const doctype = `${type} Taxes and Charges Template`;
    expect(query(fetchMock).filters).toEqual(expect.arrayContaining([
      [doctype, "company", "=", "Example Company"], [doctype, "disabled", "=", 0], [doctype, "tax_category", "=", "Standard"],
    ]));
  });

  it("returns Standard as print-format metadata without exposing template source", async () => {
    const fetchMock = vi.fn(async (_input: string) => Response.json({ message: [{ value: "Offer", description: "" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await invoke("list_print_formats", { doctype: "Quotation" });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/method/frappe.desk.search.search_link");
    expect(JSON.parse(url.searchParams.get("filters")!)).toMatchObject({ doc_type: "Quotation", disabled: 0, raw_printing: 0 });
    expect(url.searchParams.has("fields")).toBe(false);
    expect(result.structuredContent).toMatchObject({ default_format: "Standard", records: [{ name: "Offer" }] });
    expect(result.content[1].text).toContain('"default_format":"Standard"');
    await expect(invoke("list_print_formats", { doctype: "User" })).rejects.toThrow();
  });

  it("marks a full Print Format candidate search as bounded without a fake next page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: [{ value: "Offer", description: "" }] })));
    const result = await invoke("list_print_formats", { doctype: "Quotation", search: "Offer", limit: 1 });
    expect(result.structuredContent.meta).toMatchObject({ truncated: true, complete: false, next_offset: null, scope: "ranked_candidates" });
    expect(result.content[1].text).toContain("Narrow search");
  });

  it.each(["list_item_prices", "list_price_lists", "list_leads", "list_prospects", "list_quotations", "list_payment_terms_templates"])("bounds %s list size before any upstream request", async (tool) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(invoke(tool, { limit: 51 })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists sales terms without returning text blobs or inventing payment-template flags", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await invoke("list_terms_and_conditions", { selling: true });
    expect(query(fetchMock).filters).toContainEqual(["Terms and Conditions", "disabled", "=", 0]);
    expect(query(fetchMock).fields).not.toContain("terms");
    fetchMock.mockClear();
    await invoke("list_payment_terms_templates", {});
    expect(query(fetchMock).filters).toEqual([]);
    expect(query(fetchMock).fields).toContain("template_name");
  });

  it("preserves permission failures rather than reporting an empty result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    await expect(invoke("list_item_prices", { item_code: "ITEM-001" })).rejects.toThrow("PERMISSION_DENIED");
  });
});

async function invoke(name: string, input: Record<string, unknown>): Promise<Result> {
  const registration = registrations.get(name)!;
  const parsed = z.object(registration.shape as Record<string, z.ZodType>).parse(input);
  return registration.handler(parsed);
}

function query(mock: ReturnType<typeof vi.fn>): { filters: unknown[]; fields: string[] } {
  const url = new URL(String(mock.mock.calls[0][0]));
  return { filters: JSON.parse(url.searchParams.get("filters") ?? "[]"), fields: JSON.parse(url.searchParams.get("fields") ?? "[]") };
}
