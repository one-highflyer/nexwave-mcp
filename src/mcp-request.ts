import { isJsonContentType } from "@modelcontextprotocol/server";

export async function normaliseMcpToolArguments(request: Request): Promise<Request> {
  if (request.method !== "POST" || !isJsonContentType(request.headers.get("Content-Type"))) {
    return request;
  }

  let payload: unknown;
  try {
    payload = await request.clone().json();
  } catch {
    return request;
  }

  const normalised = Array.isArray(payload)
    ? payload.map(normaliseMcpMessage)
    : normaliseMcpMessage(payload);
  if (normalised === payload) return request;

  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  return new Request(request, { headers, body: JSON.stringify(normalised) });
}

function normaliseMcpMessage(value: unknown): unknown {
  if (!isRecord(value) || value.method !== "tools/call" || !isRecord(value.params)) return value;
  if (!isRecord(value.params.arguments)) return value;

  const entries = Object.entries(value.params.arguments);
  if (!entries.some(([, argument]) => argument === null)) return value;

  return {
    ...value,
    params: {
      ...value.params,
      arguments: Object.fromEntries(entries.filter(([, argument]) => argument !== null)),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
