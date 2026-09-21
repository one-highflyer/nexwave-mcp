/** Keep unexpected handler failures in the MCP protocol, without exposing internal errors. */
export async function withMcpErrorBoundary(request: Request, run: () => Promise<Response>): Promise<Response> {
  const copy = request.clone();
  try {
    return await run();
  } catch {
    let id: string | number | null = null;
    try {
      const message = await copy.json() as { id?: unknown };
      if (typeof message.id === "string" || typeof message.id === "number") id = message.id;
    } catch { /* Invalid requests must still receive a safe protocol error. */ }
    const reference = crypto.randomUUID();
    console.error(JSON.stringify({ event: "mcp_handler_failed", request_id: reference }));
    return Response.json({
      jsonrpc: "2.0", id,
      error: { code: -32603, message: "The MCP request could not be completed.", data: { reference } },
    }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
