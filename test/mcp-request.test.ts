import { describe, expect, it } from "vitest";
import { normaliseMcpToolArguments } from "../src/mcp-request";

describe("MCP request normalization", () => {
  it("removes explicit null tool arguments and keeps supplied values", async () => {
    const request = jsonRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "list_sales_invoices",
        arguments: {
          search: null,
          limit: 20,
          status: "Unpaid",
          from_date: null,
        },
      },
    });

    const normalised = await normaliseMcpToolArguments(request);

    await expect(normalised.json()).resolves.toMatchObject({
      params: {
        arguments: { limit: 20, status: "Unpaid" },
      },
    });
  });

  it("normalizes each tool call in a JSON-RPC batch", async () => {
    const request = jsonRequest([
      { method: "tools/call", params: { arguments: { search: null, limit: 10 } } },
      { method: "tools/list", params: {} },
    ]);

    const normalised = await normaliseMcpToolArguments(request);
    const payload = await normalised.json() as Array<Record<string, unknown>>;

    expect(payload[0]).toMatchObject({ params: { arguments: { limit: 10 } } });
    expect(payload[1]).toEqual({ method: "tools/list", params: {} });
  });

  it("leaves non-tool requests unchanged", async () => {
    const request = jsonRequest({ method: "tools/list", params: { value: null } });

    await expect(normaliseMcpToolArguments(request)).resolves.toBe(request);
  });
});

function jsonRequest(payload: unknown): Request {
  return new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
