import { afterEach, describe, expect, it, vi } from "vitest";
import { getDocumentPdf, MAX_PDF_BYTES, searchPrintFormats } from "../src/pdf-tool";
import type { NexWaveApiTokenAuthProps, NexWaveOAuthAuthProps } from "../src/types";

const PROPS: NexWaveApiTokenAuthProps = {
  authType: "api_token", siteId: "site_test", siteName: "Example", baseUrl: "https://example.com",
  user: "service@example.com", upstreamApiKey: "api-key", upstreamApiSecret: "api-secret",
};
const DOCUMENT = { name: "QTN-001", doctype: "Quotation", docstatus: 0 };
const PDF = "%PDF-1.7\nexample\n%%EOF";
const args = { doctype: "Quotation" as const, name: "QTN-001" };
const documentResponse = () => Response.json({ data: DOCUMENT });
const pdfResponse = (body: BodyInit = PDF, headers: Record<string, string> = {}) => new Response(body, { headers: { "Content-Type": "application/pdf", ...headers } });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("document PDF tool", () => {
  it("returns an embedded PDF and keeps credentials out of metadata and resource URI", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(documentResponse()).mockResolvedValueOnce(pdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    const result = await getDocumentPdf(PROPS, args);
    expect(result.structuredContent).toMatchObject({ doctype: "Quotation", name: "QTN-001", print_format: "Standard", filename: "QTN-001.pdf", mime_type: "application/pdf", size_bytes: PDF.length });
    const resource = result.content[1];
    expect(resource.type).toBe("resource");
    if (resource.type !== "resource" || !("blob" in resource.resource)) throw new Error("Expected embedded PDF.");
    expect(atob(resource.resource.blob)).toBe(PDF);
    expect(resource.resource.uri).toMatch(/^nexwave-pdf:\/\/document\/Quotation\/QTN-001\//);
    expect(JSON.stringify(result)).not.toContain("api-key");
    expect(JSON.stringify(result)).not.toContain("api-secret");
    expect(JSON.stringify(result)).not.toContain("example.com");
    const [input, init] = fetchMock.mock.calls[1];
    const url = new URL(String(input));
    expect(url.origin).toBe(PROPS.baseUrl);
    expect(url.pathname).toBe("/api/method/frappe.utils.print_format.download_pdf");
    expect(Object.fromEntries(url.searchParams)).toEqual({ doctype: "Quotation", name: "QTN-001", format: "Standard", no_letterhead: "0" });
    expect(init.redirect).toBe("manual");
    expect(init.headers.Authorization).toBe("token api-key:api-secret");
  });

  it("verifies a selected format belongs to the document type and passes approved rendering options", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(documentResponse())
      .mockResolvedValueOnce(Response.json({ message: [{ value: "Example Format", description: "private description" }] }))
      .mockResolvedValueOnce(pdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    const result = await getDocumentPdf(PROPS, { ...args, print_format: "Example Format", language: "en-NZ", no_letterhead: true });
    const formatUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(formatUrl.pathname).toBe("/api/method/frappe.desk.search.search_link");
    expect(formatUrl.searchParams.get("doctype")).toBe("Print Format");
    expect(formatUrl.searchParams.get("page_length")).toBe("1");
    expect(JSON.parse(formatUrl.searchParams.get("filters")!)).toEqual({ doc_type: "Quotation", disabled: 0, raw_printing: 0, name: "Example Format" });
    expect(formatUrl.searchParams.has("ignore_user_permissions")).toBe(false);
    const url = new URL(String(fetchMock.mock.calls[2][0]));
    expect(url.searchParams.get("format")).toBe("Example Format");
    expect(url.searchParams.get("language")).toBe("en-NZ");
    expect(url.searchParams.get("no_letterhead")).toBe("1");
    expect(JSON.stringify(result)).not.toContain("private description");
  });

  it.each([
    { message: [] }, { message: [{ value: "Other" }] },
  ])("rejects a named format not returned by enabled exact-name DocType selection: %j", async (payload) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(documentResponse()).mockResolvedValueOnce(Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getDocumentPdf(PROPS, { ...args, print_format: "Example Format" })).rejects.toThrow("INVALID_ARGUMENT");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses select-permission link search to list formats without requesting template HTML", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ message: [{ value: "Example Format", description: "private description" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchPrintFormats(PROPS, { doctype: "Quotation", search: "Example%", limit: 10 })).resolves.toEqual([{ name: "Example Format", doc_type: "Quotation" }]);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("txt")).toBe("Example\\%");
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual({ doc_type: "Quotation", disabled: 0, raw_printing: 0 });
    expect(url.searchParams.has("query")).toBe(false);
  });

  it.each([{}, { message: null }, { message: [{ value: "" }] }, { message: [{ value: 5 }] }])("rejects malformed print format selections: %j", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(searchPrintFormats(PROPS, { doctype: "Quotation" })).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
  });

  it("stops when the user cannot read the source document", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("private permission details", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = getDocumentPdf(PROPS, args);
    await expect(result).rejects.toThrow("PERMISSION_DENIED");
    await expect(result).rejects.not.toThrow("private permission details");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([[401, "AUTHENTICATION_REQUIRED"], [403, "PERMISSION_DENIED"], [404, "NOT_FOUND"], [302, "UPSTREAM_UNAVAILABLE"], [500, "UPSTREAM_UNAVAILABLE"]])("maps PDF HTTP %s safely and never follows redirects", async (status, code) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(documentResponse()).mockResolvedValueOnce(new Response("private upstream details", { status: Number(status), headers: { Location: "https://other.example.com" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = getDocumentPdf(PROPS, args);
    await expect(result).rejects.toThrow(String(code));
    await expect(result).rejects.not.toThrow("private upstream details");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].redirect).toBe("manual");
  });

  it.each([
    () => new Response("private HTML", { headers: { "Content-Type": "text/html" } }),
    () => pdfResponse("private HTML"),
    () => pdfResponse(new Uint8Array()),
  ])("rejects a successful response that is not a valid PDF", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(documentResponse()).mockResolvedValueOnce(response()));
    const result = getDocumentPdf(PROPS, args);
    await expect(result).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
    await expect(result).rejects.not.toThrow("private HTML");
  });

  it("rejects an oversized PDF from its length header and cancels the body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([37, 80, 68, 70, 45])); }, cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(documentResponse()).mockResolvedValueOnce(pdfResponse(body, { "Content-Length": String(MAX_PDF_BYTES + 1) })));
    await expect(getDocumentPdf(PROPS, args)).rejects.toThrow("RESULT_TOO_LARGE");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds streamed PDFs even when the length header is absent", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PDF_BYTES));
        controller.enqueue(new Uint8Array([1]));
      }, cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(documentResponse()).mockResolvedValueOnce(pdfResponse(body)));
    await expect(getDocumentPdf(PROPS, args)).rejects.toThrow("RESULT_TOO_LARGE");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses the OAuth user's token without introducing service credentials", async () => {
    const props: NexWaveOAuthAuthProps = {
      siteId: PROPS.siteId, siteName: PROPS.siteName, baseUrl: PROPS.baseUrl, user: "user@example.com",
      upstreamAccessToken: "oauth-token", upstreamClientId: "client", upstreamClientSecret: "secret", upstreamExpiresAt: Date.now() + 3_600_000,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(documentResponse()).mockResolvedValueOnce(pdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    await getDocumentPdf(props, args);
    expect(fetchMock.mock.calls.every((call) => call[1].headers.Authorization === "Bearer oauth-token")).toBe(true);
  });

  it("aborts PDF generation at the shared tool deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce(documentResponse()).mockImplementationOnce((_input, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = getDocumentPdf({ ...PROPS, requestDeadline: Date.now() + 500 }, args);
    const check = expect(result).rejects.toThrow("UPSTREAM_TIMEOUT");
    await vi.advanceTimersByTimeAsync(500);
    await check;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects unapproved DocTypes and arbitrary endpoint options before using credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getDocumentPdf(PROPS, { ...args, doctype: "User" as "Quotation" })).rejects.toThrow();
    await expect(getDocumentPdf(PROPS, { ...args, doc: { doctype: "User" } } as typeof args)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
