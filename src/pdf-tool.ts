import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { frappeGet } from "./frappe";
import { registerReadTool } from "./tool-contract";
import { ToolError } from "./tool-result";
import type { NexWaveAuthProps } from "./types";

export const PDF_DOCTYPES = [
  "Quotation", "Sales Order", "Sales Invoice", "Purchase Order", "Purchase Invoice",
  "Purchase Receipt", "Delivery Note", "Payment Entry", "Supplier Quotation",
] as const;

export const MAX_PDF_BYTES = 5 * 1024 * 1024;
const PDF_TIMEOUT_MS = 30_000;
const pdfInput = z.object({
  doctype: z.enum(PDF_DOCTYPES),
  name: z.string().trim().min(1).max(140),
  print_format: z.string().trim().min(1).max(140).default("Standard"),
  language: z.string().trim().regex(/^[A-Za-z0-9_-]{1,35}$/).optional(),
  no_letterhead: z.boolean().default(false),
}).strict();

export function registerPdfTool(server: McpServer, currentProps: () => Promise<NexWaveAuthProps>): void {
  registerReadTool(server, "get_document_pdf", {
    description: "Generate a PDF for an accessible saved business document. Uses Standard unless a print_format name from list_print_formats is supplied. Frappe applies its normal print permissions and draft-print settings. Returns an embedded PDF file, never a public download link. Maximum PDF size is 5 MiB; file display/download support depends on the MCP client.",
    inputSchema: pdfInput.shape,
  }, async (args) => getDocumentPdf(await currentProps(), args));
}

/** Read an existing document through the user's API, then let Frappe render its approved format. */
export async function getDocumentPdf(props: NexWaveAuthProps, input: z.input<typeof pdfInput>): Promise<CallToolResult> {
  const args = pdfInput.parse(input);
  const document = await frappeGet<Record<string, unknown>>(props, args.doctype, args.name);
  if (document.name !== args.name || (document.doctype !== undefined && document.doctype !== args.doctype)) {
    throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned an unexpected document for PDF generation.");
  }
  if (args.print_format !== "Standard") {
    const formats = await searchPrintFormats(props, { doctype: args.doctype, exact_name: args.print_format, limit: 1 });
    if (!formats.some((format) => format.name === args.print_format)) {
      throw new ToolError("INVALID_ARGUMENT", "The print format must be enabled and belong to the selected DocType.");
    }
  }

  const remaining = props.requestDeadline === undefined ? PDF_TIMEOUT_MS : props.requestDeadline - Date.now();
  if (remaining <= 0) throw new ToolError("UPSTREAM_TIMEOUT", "The PDF request time limit was reached.", true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(PDF_TIMEOUT_MS, remaining));
  try {
    const url = new URL("/api/method/frappe.utils.print_format.download_pdf", props.baseUrl);
    url.searchParams.set("doctype", args.doctype);
    url.searchParams.set("name", args.name);
    url.searchParams.set("format", args.print_format);
    url.searchParams.set("no_letterhead", args.no_letterhead ? "1" : "0");
    if (args.language) url.searchParams.set("language", args.language);
    const response = await fetch(url.toString(), {
      headers: { Authorization: upstreamAuthorization(props), Accept: "application/pdf" },
      redirect: "manual", signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new ToolError("AUTHENTICATION_REQUIRED", "The NexWave connection needs to be authenticated again.");
      if (response.status === 403) throw new ToolError("PERMISSION_DENIED", "The signed-in NexWave user cannot print this document.");
      if (response.status === 404) throw new ToolError("NOT_FOUND", "The requested NexWave document or print format was not found.");
      if (response.status >= 300 && response.status < 400) throw new ToolError("UPSTREAM_UNAVAILABLE", "NexWave returned a redirect while generating the PDF.");
      throw new ToolError("UPSTREAM_UNAVAILABLE", `NexWave could not generate the PDF (HTTP ${response.status}).`, response.status === 429 || response.status >= 500);
    }
    if (Number(response.headers.get("Content-Length")) > MAX_PDF_BYTES) {
      await response.body?.cancel();
      throw new ToolError("RESULT_TOO_LARGE", "The PDF exceeds the 5 MiB file limit.");
    }
    if (response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/pdf") {
      await response.body?.cancel();
      throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave did not return a PDF document.");
    }
    const bytes = await readPdf(response);
    const filename = `${args.name.replace(/[^A-Za-z0-9_.-]/g, "_")}.pdf`;
    const resourceUri = `nexwave-pdf://document/${encodeURIComponent(args.doctype)}/${encodeURIComponent(args.name)}/${crypto.randomUUID()}.pdf`;
    const metadata = {
      doctype: args.doctype, name: args.name, print_format: args.print_format,
      filename, mime_type: "application/pdf", size_bytes: bytes.byteLength, resource_uri: resourceUri,
    };
    return {
      structuredContent: metadata,
      content: [
        { type: "text", text: JSON.stringify(metadata) },
        { type: "resource", resource: { uri: resourceUri, mimeType: "application/pdf", blob: encodeBase64(bytes) } },
      ],
    };
  } catch (error) {
    if (controller.signal.aborted) throw new ToolError("UPSTREAM_TIMEOUT", "NexWave did not generate the PDF in time.", true);
    if (error instanceof ToolError) throw error;
    throw new ToolError("UPSTREAM_UNAVAILABLE", "The NexWave PDF request failed. Please try again later.", true);
  } finally {
    clearTimeout(timer);
  }
}

/** Link search preserves Print Format select permissions without granting access to template HTML. */
export async function searchPrintFormats(
  props: NexWaveAuthProps,
  input: { doctype: typeof PDF_DOCTYPES[number]; search?: string; exact_name?: string; limit?: number },
): Promise<Array<{ name: string; doc_type: string }>> {
  const doctype = z.enum(PDF_DOCTYPES).parse(input.doctype);
  const limit = z.number().int().min(1).max(50).parse(input.limit ?? 20);
  const search = z.string().trim().max(140).parse(input.search ?? "");
  const exactName = z.string().trim().min(1).max(140).optional().parse(input.exact_name);
  const remaining = props.requestDeadline === undefined ? PDF_TIMEOUT_MS : props.requestDeadline - Date.now();
  if (remaining <= 0) throw new ToolError("UPSTREAM_TIMEOUT", "The print format request time limit was reached.", true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(PDF_TIMEOUT_MS, remaining));
  try {
    const url = new URL("/api/method/frappe.desk.search.search_link", props.baseUrl);
    url.searchParams.set("doctype", "Print Format");
    url.searchParams.set("txt", search.replace(/[\\%_]/g, "\\$&"));
    url.searchParams.set("filters", JSON.stringify({ doc_type: doctype, disabled: 0, raw_printing: 0, ...(exactName ? { name: exactName } : {}) }));
    url.searchParams.set("page_length", String(limit));
    const response = await fetch(url.toString(), {
      headers: { Authorization: upstreamAuthorization(props), Accept: "application/json" },
      redirect: "manual", signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new ToolError("AUTHENTICATION_REQUIRED", "The NexWave connection needs to be authenticated again.");
      if (response.status === 403) throw new ToolError("PERMISSION_DENIED", "The signed-in NexWave user cannot select this print format.");
      throw new ToolError("UPSTREAM_UNAVAILABLE", "NexWave could not return the permitted print formats.", response.status === 429 || response.status >= 500);
    }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(await readBoundedBytes(response, 64 * 1024))); }
    catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned invalid print format data.");
    }
    if (!payload || typeof payload !== "object" || !("message" in payload)
      || !Array.isArray(payload.message) || payload.message.length > limit
      || !payload.message.every((row: unknown) => row && typeof row === "object" && "value" in row && typeof row.value === "string" && row.value.trim())) {
      throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned invalid print format data.");
    }
    return payload.message.map((row: { value: string }) => ({ name: row.value, doc_type: doctype }));
  } catch (error) {
    if (controller.signal.aborted) throw new ToolError("UPSTREAM_TIMEOUT", "NexWave did not return print formats in time.", true);
    if (error instanceof ToolError) throw error;
    throw new ToolError("UPSTREAM_UNAVAILABLE", "The NexWave print format request failed.", true);
  } finally { clearTimeout(timer); }
}

async function readPdf(response: Response): Promise<Uint8Array> {
  const bytes = await readBoundedBytes(response, MAX_PDF_BYTES);
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned an invalid PDF document.");
  }
  return bytes;
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ToolError("RESULT_TOO_LARGE", "The NexWave response exceeds the file or print format limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function upstreamAuthorization(props: NexWaveAuthProps): string {
  return props.authType === "api_token" ? `token ${props.upstreamApiKey}:${props.upstreamApiSecret}` : `Bearer ${props.upstreamAccessToken}`;
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(""));
}
