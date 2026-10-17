import { afterEach, describe, expect, it, vi } from "vitest";
import { listResult, literalLike, normaliseName, searchRecords } from "../src/search";
import type { NexWaveApiTokenAuthProps } from "../src/types";

const props: NexWaveApiTokenAuthProps = { authType: "api_token", siteId: "test", siteName: "Example", baseUrl: "https://example.com", user: "test@example.com", upstreamApiKey: "key", upstreamApiSecret: "secret" };
const fields = ["name", "supplier_name", "disabled"];
const searchFields = ["name", "supplier_name"];
afterEach(() => vi.unstubAllGlobals());

describe("bounded directory search", () => {
  it("finds suffix and punctuation variants while keeping explicit filters", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({ data: [{ name: "SUP-001", supplier_name: "Example Office, Ltd." }] }));
    vi.stubGlobal("fetch", fetchMock);
    const filters = [["Supplier", "disabled", "=", 0], ["Supplier", "supplier_group", "=", "Wholesale"]];
    const result = await searchRecords(props, "Supplier", fields, searchFields, { search: "Example Office Limited", filters, limit: 5, directory: true, legalNames: true });
    expect(result.meta).toMatchObject({ match_status: "matched", matched_id: "SUP-001", broadened: true });
    for (const [url] of fetchMock.mock.calls) {
      const parsed = new URL(String(url));
      expect(JSON.parse(parsed.searchParams.get("filters")!)).toEqual(filters);
      expect(parsed.searchParams.get("limit_page_length")).toBe("50");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires confirmation when two legal names normalize to the same text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [
      { name: "SUP-001", supplier_name: "Example Limited" },
      { name: "SUP-002", supplier_name: "Example Ltd" },
    ] })));
    const result = await searchRecords(props, "Supplier", fields, searchFields, { search: "Example Limited", limit: 5, directory: true, legalNames: true });
    expect(result.meta.match_status).toBe("candidates");
    expect(result.meta.matched_id).toBeUndefined();
  });

  it("never auto-selects a truncated display-name match", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({ name: `SUP-${index}`, supplier_name: index ? `Example ${index}` : "Example" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: rows })));
    const result = await searchRecords(props, "Supplier", fields, searchFields, { search: "Example", limit: 3, directory: true });
    expect(result.records).toHaveLength(3);
    expect(result.meta).toMatchObject({ match_status: "candidates", truncated: true });
  });

  it("preserves identifiers and treats wildcard characters as literals", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await searchRecords(props, "Sales Invoice", ["name"], ["name"], { search: "INV_25%", limit: 1 });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(JSON.parse(url.searchParams.get("or_filters")!)).toEqual([["Sales Invoice", "name", "like", "%INV\\_25\\%%"]]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(literalLike("A\\B")).toBe("A\\\\B");
  });

  it("does not strip legal suffixes from item searches", () => {
    expect(normaliseName("Widget Limited")).toBe("widget limited");
    expect(normaliseName(" Example,  Pty. Ltd. ", true)).toBe("example");
  });

  it("does not broaden a search after a permission error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("private detail", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchRecords(props, "Supplier", fields, searchFields, { search: "Example Office", limit: 5, directory: true })).rejects.toThrow("PERMISSION_DENIED");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("list pages and complete aggregates", () => {
  it("pages literal matches in stable order and preserves text-only completeness", async () => {
    const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
      const url = new URL(input);
      const start = Number(url.searchParams.get("limit_start"));
      return Response.json({ data: ["A", "B", "C"].slice(start, start + 2).map((name) => ({ name })) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const options = { search: "INV_", limit: 2, filters: [["Sales Invoice", "docstatus", "=", 1]], orderBy: "posting_date desc" };
    const first = await listResult(props, "Sales Invoice", ["name"], ["name"], options);
    expect(JSON.parse(first.content[0].text)).toEqual([{ name: "A" }, { name: "B" }]);
    expect(JSON.parse(first.content[1].text)).toEqual({ meta: first.structuredContent.meta });
    expect(first.structuredContent.meta).toMatchObject({ next_offset: 2, complete: false, truncated: true });
    const last = await listResult(props, "Sales Invoice", ["name"], ["name"], { ...options, offset: 2 });
    expect(last.structuredContent.records).toEqual([{ name: "C" }]);
    expect(last.structuredContent.meta).toMatchObject({ offset: 2, next_offset: null, complete: false, truncated: false });
    for (const [input] of fetchMock.mock.calls) {
      const url = new URL(input);
      expect(url.searchParams.get("order_by")).toBe("posting_date desc, name asc");
      expect(JSON.parse(url.searchParams.get("filters")!)).toEqual(options.filters);
      expect(JSON.parse(url.searchParams.get("or_filters")!)).toEqual([["Sales Invoice", "name", "like", "%INV\\_%"]]);
    }
  });

  it("distinguishes bounded candidate pages from full directory pagination", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ name: `SUP-${i}`, supplier_name: "Example" }));
    const fetchMock = vi.fn(async (_input: string) => Response.json({ data: rows }));
    vi.stubGlobal("fetch", fetchMock);
    const ranked = await searchRecords(props, "Supplier", fields, searchFields, { search: "Example", limit: 20, offset: 40, directory: true });
    expect(ranked.records).toHaveLength(10);
    expect(ranked.meta).toMatchObject({ next_offset: null, complete: false, truncated: true, candidate_retrieval_complete: false, scope: "ranked_candidates" });
    expect(ranked.meta.warning).toContain("literal");
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("limit_start")).toBe("0");
    await searchRecords(props, "Supplier", fields, searchFields, { search: "Example", limit: 20, offset: 50, directory: true, search_mode: "literal" });
    const url = new URL(String(fetchMock.mock.calls[1][0]));
    expect(url.searchParams.get("limit_start")).toBe("50");
    expect(url.searchParams.get("limit_page_length")).toBe("20");
  });

  it("counts all matching records independently of display offset and limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{ record_count: 105 }] }));
    vi.stubGlobal("fetch", fetchMock);
    const filters = [["Sales Invoice", "docstatus", "=", 1]];
    const result = await listResult(props, "Sales Invoice", ["name"], ["name"], { summary: "count", search: "INV_", filters, offset: 50, limit: 2 });
    expect(result.structuredContent).toMatchObject({ count: 105, complete: true });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(JSON.parse(url.searchParams.get("fields")!)).toEqual(["count(name) as record_count"]);
    expect(url.searchParams.has("limit_start")).toBe(false);
    expect(url.searchParams.get("order_by")).toBe("count(name) asc");
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual(filters);
    expect(JSON.parse(url.searchParams.get("or_filters")!)).toEqual([["Sales Invoice", "name", "like", "%INV\\_%"]]);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "token key:secret" });
  });

  it("returns document-currency totals and excludes unsafe outstanding amounts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [{ record_count: 105, total_grand_total: 12345 }] }));
    vi.stubGlobal("fetch", fetchMock);
    const filters = [["Sales Invoice", "company", "=", "Example Company"], ["Sales Invoice", "currency", "=", "NZD"]];
    const result = await listResult(props, "Sales Invoice", ["name"], ["name"], { summary: "totals", filters, limit: 1 });
    expect(result.structuredContent).toMatchObject({ count: 105, totals: { grand_total: 12345 }, company: "Example Company", currency: "NZD", totals_complete: true });
    expect(JSON.parse(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("fields")!)).toEqual(["count(name) as record_count", "sum(grand_total) as total_grand_total"]);
  });

  it.each([
    { summary: "totals" as const, filters: [] },
    { summary: "totals" as const, filters: [["Sales Invoice", "company", "=", "Example Company"]] },
  ])("rejects monetary totals without currency scope before fetching", async (options) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(listResult(props, "Sales Invoice", ["name"], ["name"], { ...options, limit: 1 })).rejects.toThrow("Totals require");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects aggregates of ranked directory candidates", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(listResult(props, "Supplier", fields, searchFields, { summary: "count", search: "Example", directory: true, limit: 20 })).rejects.toThrow("literal");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [], [{ record_count: -1 }], [{ record_count: "3" }], [{ record_count: 3 }],
    [{ record_count: 3, total_grand_total: null }], [{ record_count: 0 }],
    [{ record_count: 3, total_grand_total: "123" }],
  ].map((rows) => ({ rows })))("rejects missing or invalid aggregate aliases: %j", async ({ rows }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: rows })));
    await expect(listResult(props, "Sales Invoice", ["name"], ["name"], { summary: "totals", filters: [["Sales Invoice", "company", "=", "Example Company"], ["Sales Invoice", "currency", "=", "NZD"]], limit: 1 })).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
  });

  it("accepts a null sum only for a confirmed empty match set", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{ record_count: 0, total_grand_total: null }] })));
    const result = await listResult(props, "Sales Invoice", ["name"], ["name"], { summary: "totals", filters: [["Sales Invoice", "company", "=", "Example Company"], ["Sales Invoice", "currency", "=", "NZD"]], limit: 1 });
    expect(result.structuredContent).toMatchObject({ count: 0, totals: { grand_total: 0 } });
  });
});
