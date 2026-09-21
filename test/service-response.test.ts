import { afterEach, expect, it, vi } from "vitest";
import { SERVICE_ERROR_FORMAT_HEADER, withServiceToolJsonResponse } from "../src/service-response";

afterEach(() => vi.useRealTimers());
const payload = { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: '{"error":{"code":"INVALID_ARGUMENT"}}' }] } };
const request = (method = "tools/call", signal?: AbortSignal) => new Request("https://example.com/service/mcp", {
  method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }), signal,
});
const sse = (body: string | ReadableStream<Uint8Array>) => new Response(body, { headers: { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" } });

it("returns JSON without changing the error flag, content or request ID", async () => {
  const response = await withServiceToolJsonResponse(request(), async () => sse(`data: ${JSON.stringify(payload)}\n\n`));
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(await response.json()).toEqual(payload);
});

it.each(["INVALID_ARGUMENT", "UPSTREAM_TIMEOUT", "PERMISSION_DENIED", "NOT_FOUND"])("delivers an explicit opt-in %s envelope", async (code) => {
  const req = request();
  req.headers.set(SERVICE_ERROR_FORMAT_HEADER, "result");
  const error = { code, message: "Safe explanation", retryable: code === "UPSTREAM_TIMEOUT" };
  const message = { ...payload, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] } };
  const response = await withServiceToolJsonResponse(req, async () => sse(`data: ${JSON.stringify(message)}\n\n`));
  const body = await response.json() as { id: number; result: { isError: boolean; content: Array<{ text: string }>; structuredContent: unknown } };
  expect(body.id).toBe(1);
  expect(body.result.isError).toBe(false);
  expect(body.result.structuredContent).toEqual({ status: "error", ok: false, error });
  expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);
});

it.each([
  ["Input validation failed for tool: private supplied value", "INVALID_ARGUMENT"],
  ["private unexpected exception", "INTERNAL_ERROR"],
  ['{"error":{"code":"UNKNOWN","message":"private"}}', "INTERNAL_ERROR"],
])("sanitises unstructured errors in opt-in mode", async (text, code) => {
  const req = request();
  req.headers.set(SERVICE_ERROR_FORMAT_HEADER, "result");
  const message = { ...payload, result: { isError: true, content: [{ type: "text", text }] } };
  const response = await withServiceToolJsonResponse(req, async () => sse(`data: ${JSON.stringify(message)}\n\n`));
  const body = await response.text();
  expect(body).toContain(code);
  expect(body).not.toContain("private");
});

it("does not convert protocol errors or successful data in opt-in mode", async () => {
  const req = request();
  req.headers.set(SERVICE_ERROR_FORMAT_HEADER, "result");
  for (const message of [
    { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Unknown method" } },
    { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"records":[]}' }] } },
  ]) {
    const response = await withServiceToolJsonResponse(req, async () => sse(`data: ${JSON.stringify(message)}\n\n`));
    expect(await response.json()).toEqual(message);
  }
});

it("handles split UTF-8, CRLF, comments, multiline data and unrelated IDs", async () => {
  const success = { ...payload, result: { content: [{ type: "text", text: "café" }], structuredContent: { status: "matched" } } };
  const text = `: keepalive\r\n\r\ndata: ${JSON.stringify({ ...payload, id: 2 })}\r\n\r\ndata: ${JSON.stringify(success, null, 2).split("\n").join("\r\ndata: ")}\r\n\r\n`;
  const cancelled = vi.fn();
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(bytes.slice(index, ++index)); }, cancel: cancelled });
  const response = await withServiceToolJsonResponse(request(), async () => sse(stream));
  expect(await response.json()).toEqual(success);
  expect(cancelled).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
});

it.each([401, 403, 202, 400, 500])("preserves HTTP %i", async (status) => {
  const response = new Response(null, { status });
  expect(await withServiceToolJsonResponse(request(), async () => response)).toBe(response);
});

it("preserves JSON, discovery, notifications, batches and malformed requests", async () => {
  const response = sse(`data: ${JSON.stringify(payload)}\n\n`);
  for (const body of ["invalid", "null", JSON.stringify([{ id: 1, method: "tools/call" }]), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })]) {
    expect(await withServiceToolJsonResponse(new Request("https://example.com/service/mcp", { method: "POST", body }), async () => response)).toBe(response);
  }
  expect(await withServiceToolJsonResponse(request("tools/list"), async () => response)).toBe(response);
  const json = Response.json(payload);
  expect(await withServiceToolJsonResponse(request(), async () => json)).toBe(json);
});

it.each(["data: invalid\n\n", `data: ${JSON.stringify(payload)}`, "data: {}\n\n", ":" + "x".repeat(2 * 1024 * 1024)])("rejects malformed, incomplete or oversized streams safely", async (body) => {
  await expect(withServiceToolJsonResponse(request(), async () => sse(body))).rejects.toBeInstanceOf(Error);
});

it("cancels and unlocks a stalled stream at the deadline", async () => {
  vi.useFakeTimers();
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
  const result = withServiceToolJsonResponse(request(), async () => sse(stream));
  const assertion = expect(result).rejects.toThrow("Incomplete");
  await vi.advanceTimersByTimeAsync(12_001);
  await assertion;
  expect(cancelled).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
});

it("cancels a stream when the caller disconnects", async () => {
  const controller = new AbortController();
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
  const result = withServiceToolJsonResponse(request("tools/call", controller.signal), async () => { controller.abort(); return sse(stream); });
  await expect(result).rejects.toThrow("cancelled");
  expect(cancelled).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
});
