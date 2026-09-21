/** Safe errors contain no upstream response bodies or authentication data. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    // The SDK converts thrown tool errors to isError content for every MCP transport.
    super(JSON.stringify({ error: { code, message, retryable } }));
  }
}

export function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function structuredResult(value: Record<string, unknown>, legacyValue: unknown = value) {
  return { ...textResult(legacyValue), structuredContent: value };
}
