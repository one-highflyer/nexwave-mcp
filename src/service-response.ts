const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 12_000;

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
        return Response.json(message, { headers });
      }
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
