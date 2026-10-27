import { isJSONRPCRequest, type JSONRPCMessage, type McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";

const METHODS = new Set(["initialize", "ping", "tools/list", "tools/call", "resources/list", "resources/templates/list", "resources/read", "prompts/list", "prompts/get", "server/discover"]);
const ERROR_CODES = new Set([
  "INVALID_ARGUMENT", "AUTHENTICATION_REQUIRED", "NOT_FOUND", "PERMISSION_DENIED",
  "RESULT_TOO_LARGE", "UPSTREAM_INVALID_RESPONSE", "UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE",
]);

/** Observe protocol messages before service response conversion, without reading response streams. */
export function withMcpUsageLogging(server: McpServer): McpServer {
  const props = getMcpAuthContext()?.props;
  if (typeof props?.siteId !== "string" || typeof props.siteName !== "string") return server;
  // Copy only the verified site identity. Never retain or spread authentication props into a log.
  const identity = {
    site_id: props.siteId,
    site_name: props.siteName,
    auth_type: props.authType === "api_token" ? "api_token" : "oauth",
  };
  const connect = server.connect.bind(server);
  server.connect = async (transport) => {
    await connect(transport);
    const pending = new Map<string | number, { started: number; request_id: string; method: string; tool: string | null }>();
    const finish = (id: string | number, outcome: "success" | "error" | "cancelled", errorCode: string | null) => {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      try {
        console.log({
          event: "mcp_request",
          ...identity,
          timestamp: new Date(call.started).toISOString(),
          request_id: call.request_id,
          method: call.method,
          tool: call.tool,
          outcome,
          error_code: errorCode,
          duration_ms: Math.max(0, Date.now() - call.started),
        });
      } catch { /* Logging must not change MCP responses. */ }
    };
    const onmessage = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if (isJSONRPCRequest(message)) {
        const name = message.method === "tools/call" ? message.params?.name : undefined;
        pending.set(message.id, {
          started: Date.now(),
          request_id: crypto.randomUUID(),
          method: METHODS.has(message.method) ? message.method : "unknown",
          tool: message.method === "tools/call"
            ? typeof name === "string" && server.toolInputSchemaJson(name) !== undefined ? name : "unknown"
            : null,
        });
      }
      onmessage?.(message, extra);
    };
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if ("id" in message && (typeof message.id === "string" || typeof message.id === "number") && !("method" in message)) {
        const errorCode = responseErrorCode(message);
        finish(message.id, errorCode ? "error" : "success", errorCode);
      }
      return send(message, options);
    };
    const onclose = transport.onclose;
    transport.onclose = () => {
      for (const id of pending.keys()) finish(id, "cancelled", "CONNECTION_CLOSED");
      onclose?.();
    };
  };
  return server;
}

function responseErrorCode(message: JSONRPCMessage): string | null {
  if ("error" in message) {
    if (message.error.code === -32602) return "INVALID_ARGUMENT";
    if (message.error.code === -32601) return "METHOD_NOT_FOUND";
    if (message.error.code === -32603) return "INTERNAL_ERROR";
    return "PROTOCOL_ERROR";
  }
  if (!("result" in message) || message.result.isError !== true) return null;
  const content = message.result.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  if (first?.type === "text" && typeof first.text === "string") {
    if (first.text.startsWith("Input validation")) return "INVALID_ARGUMENT";
    try {
      const code: unknown = JSON.parse(first.text)?.error?.code;
      if (typeof code === "string" && ERROR_CODES.has(code)) return code;
    } catch { /* Unexpected error text can contain private data. */ }
  }
  return "TOOL_ERROR";
}
