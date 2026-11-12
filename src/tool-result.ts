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

/** Report schema paths, never supplied values or unknown object keys. */
export function invalidWriteArguments(issues: ReadonlyArray<{ path: readonly PropertyKey[] }>, hint = ""): ToolError {
  const paths = [...new Set(issues.map(({ path }) => path.map((part) => typeof part === "number" && Number.isSafeInteger(part) && part >= 0
    ? `[${part}]` : typeof part === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(part) ? `.${part}` : "").join("").replace(/^\./, "")).filter(Boolean))].slice(0, 10);
  return new ToolError("INVALID_ARGUMENT", `Check required fields and values${paths.length ? ` at: ${paths.join(", ")}` : " in the tool schema"}.${hint ? ` ${hint}` : ""}`);
}

export function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function structuredResult(value: Record<string, unknown>, legacyValue: unknown = value) {
  return { ...textResult(legacyValue), structuredContent: value };
}
