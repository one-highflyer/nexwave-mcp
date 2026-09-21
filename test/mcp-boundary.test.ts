import { expect, it } from "vitest";
import { withMcpErrorBoundary } from "../src/mcp-boundary";

it("preserves successful and authentication responses", async () => {
  const response = new Response("denied", { status: 401 });
  expect(await withMcpErrorBoundary(new Request("https://example.com/mcp"), async () => response)).toBe(response);
});

it("keeps the request ID and suppresses private exception details", async () => {
  const request = new Request("https://example.com/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/list" }) });
  const response = await withMcpErrorBoundary(request, async () => { await request.text(); throw new Error("private configuration"); });
  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body).toMatchObject({ jsonrpc: "2.0", id: 42, error: { code: -32603 } });
  expect(JSON.stringify(body)).not.toContain("private configuration");
});
