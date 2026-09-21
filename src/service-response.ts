const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 40_000;
export const SERVICE_ERROR_FORMAT_HEADER = "X-MCP-Error-Format";
const SAFE_ERROR_CODES = new Set([
  "INVALID_ARGUMENT", "AUTHENTICATION_REQUIRED", "NOT_FOUND", "PERMISSION_DENIED",
  "RESULT_TOO_LARGE", "UPSTREAM_INVALID_RESPONSE", "UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE",
]);

/** Return finite service tool replies as JSON. OAuth and MCP error semantics stay unchanged. */
export async function withServiceToolJsonResponse(
  request: Request,
  run: () => Promise<Response>,
): Promise<Response> {
  let id: string | number | undefined;
  if (request.method === "POST") {
    try {
      const message = await request.clone().json() as Record<string, unknown> | null;
      if (message?.jsonrpc === "2.0" && message.method === "tools/call"
        && (typeof message.id === "string" || typeof message.id === "number")) id = message.id;
    } catch { /* Let the SDK report malformed requests. */ }
  }
  const response = await run();
  if (id === undefined || response.status !== 200 || !response.body
    || !response.headers.get("Content-Type")?.startsWith("text/event-stream")) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  const timer = setTimeout(() => { void reader.cancel().catch(() => undefined); }, RESPONSE_TIMEOUT_MS);
  const abort = () => { void reader.cancel().catch(() => undefined); };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal.aborted) throw new Error("Service request cancelled.");
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Incomplete service tool response.");
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Service tool response exceeds limit.");
      buffer += decoder.decode(chunk.value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        const message = JSON.parse(data) as Record<string, unknown> | null;
        if (message?.jsonrpc !== "2.0" || message.id !== id || !("result" in message || "error" in message)) continue;
        const headers = new Headers(response.headers);
        headers.set("Content-Type", "application/json");
        headers.set("Cache-Control", "no-store");
        headers.delete("Content-Length");
        headers.delete("Content-Encoding");
        const body = request.headers.get(SERVICE_ERROR_FORMAT_HEADER) === "result"
          ? withErrorEnvelope(message) : message;
        return Response.json(body, { headers });
      }
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Opt-in for clients that discard MCP tool errors. The payload still declares failure. */
function withErrorEnvelope(message: Record<string, unknown>): Record<string, unknown> {
  const result = message.result;
  if (!isRecord(result) || result.isError !== true) return message;
  let error = { code: "INTERNAL_ERROR", message: "The tool request could not be completed.", retryable: false };
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = isRecord(first) && first.type === "text" && typeof first.text === "string" ? first.text : "";
  if (text.startsWith("Input validation failed")) {
    error = { code: "INVALID_ARGUMENT", message: "The tool arguments do not match its schema. Check required fields and allowed values.", retryable: false };
  } else {
    try {
      const parsed: unknown = JSON.parse(text);
      const candidate = isRecord(parsed) ? parsed.error : undefined;
      if (isRecord(candidate) && typeof candidate.code === "string" && SAFE_ERROR_CODES.has(candidate.code)
        && typeof candidate.message === "string" && typeof candidate.retryable === "boolean") {
        error = { code: candidate.code, message: candidate.message, retryable: candidate.retryable };
      }
    } catch { /* Never expose unexpected exception details in the compatibility envelope. */ }
  }
  const failure = { status: "error", ok: false, error };
  return { ...message, result: {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(failure) }],
    structuredContent: failure,
  } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
