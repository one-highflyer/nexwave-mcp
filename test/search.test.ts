import { afterEach, describe, expect, it, vi } from "vitest";
import { literalLike, normaliseName, searchRecords } from "../src/search";
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
