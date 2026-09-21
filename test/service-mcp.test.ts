import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticateServiceMcpRequest,
  handleServiceMcpRequest,
  SERVICE_MCP_TOKEN_HEADER,
} from "../src/service-mcp";
import { encryptSecret, sha256 } from "../src/security";
import type { Env, SiteRecord } from "../src/types";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("service MCP authentication", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps a valid gateway token to a registered site's API token", async () => {
    const site = await apiTokenSite();
    const result = await authenticateServiceMcpRequest(serviceRequest("gateway-token"), serviceEnv(site));

    expect(result).toEqual({
      props: {
        authType: "api_token",
        siteId: "site_test",
        siteName: "Demo",
        baseUrl: "https://demo.example.com",
        user: "service@example.com",
        upstreamApiKey: "api-key",
        upstreamApiSecret: "api-secret",
      },
    });
  });

  it("rejects a missing or invalid gateway token", async () => {
    const site = await apiTokenSite();
    const missing = await authenticateServiceMcpRequest(serviceRequest(), serviceEnv(site));
    const invalid = await authenticateServiceMcpRequest(serviceRequest("wrong-token"), serviceEnv(site));

    expect("response" in missing && missing.response.status).toBe(401);
    expect("response" in invalid && invalid.response.status).toBe(401);
  });

  it("rejects a disabled or unregistered site", async () => {
    const site = await apiTokenSite();
    const disabled = await authenticateServiceMcpRequest(
      serviceRequest("gateway-token"),
      serviceEnv({ ...site, enabled: 0 }),
    );
    const missing = await authenticateServiceMcpRequest(serviceRequest("gateway-token"), serviceEnv(null));

    expect("response" in disabled && disabled.response.status).toBe(403);
    expect("response" in missing && missing.response.status).toBe(401);
  });

  it("rejects a token mapped to an OAuth site", async () => {
    const site = await apiTokenSite();
    const oauthSite: SiteRecord = {
      ...site,
      auth_type: "oauth",
      client_id: "oauth-client-id",
      encrypted_client_secret: "encrypted-oauth-secret",
      encrypted_api_key: null,
      encrypted_api_secret: null,
      api_user: null,
    };

    const result = await authenticateServiceMcpRequest(serviceRequest("gateway-token"), serviceEnv(oauthSite));

    expect("response" in result && result.response.status).toBe(503);
  });

  it("accepts null values for optional tool arguments", async () => {
    const site = await apiTokenSite();
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: [{ name: "INV-00001", status: "Unpaid", outstanding_amount: 125 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleServiceMcpRequest(
      serviceToolRequest("gateway-token", "list_sales_invoices", {
        search: null,
        limit: 50,
        company: null,
        customer: null,
        status: "Unpaid",
        from_date: null,
        to_date: null,
      }),
      serviceEnv(site),
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    const payload = JSON.parse(dataLine?.slice(6) ?? "null") as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(JSON.parse(payload.result?.content?.[0]?.text ?? "null")).toEqual([
      { name: "INV-00001", status: "Unpaid", outstanding_amount: 125 },
    ]);

    const [url] = fetchMock.mock.calls[0];
    const upstream = new URL(String(url));
    expect(JSON.parse(upstream.searchParams.get("filters") ?? "[]")).toEqual([
      ["Sales Invoice", "status", "=", "Unpaid"],
    ]);
  });

  it("lists purchase orders using bounded, permission-aware Frappe filters", async () => {
    const site = await apiTokenSite();
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: [{ name: "PO-00001", supplier: "SUP-00001", status: "To Receive and Bill" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleServiceMcpRequest(
      serviceToolRequest("gateway-token", "list_purchase_orders", {
        search: "Example",
        limit: 25,
        company: "Example Company",
        supplier: "SUP-00001",
        status: "To Receive and Bill",
        from_date: "2026-09-01",
        to_date: "2026-09-30",
      }),
      serviceEnv(site),
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(fetchMock, body).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    const upstream = new URL(String(url));
    expect(upstream.pathname).toBe("/api/resource/Purchase%20Order");
    expect(upstream.searchParams.get("limit_page_length")).toBe("25");
    expect(upstream.searchParams.get("order_by")).toBe("transaction_date desc");
    expect(JSON.parse(upstream.searchParams.get("filters") ?? "[]")).toEqual([
      ["Purchase Order", "company", "=", "Example Company"],
      ["Purchase Order", "supplier", "=", "SUP-00001"],
      ["Purchase Order", "status", "=", "To Receive and Bill"],
      ["Purchase Order", "transaction_date", ">=", "2026-09-01"],
      ["Purchase Order", "transaction_date", "<=", "2026-09-30"],
    ]);
    expect(JSON.parse(upstream.searchParams.get("or_filters") ?? "[]")).toEqual([
      ["Purchase Order", "name", "like", "%Example%"],
      ["Purchase Order", "supplier_name", "like", "%Example%"],
    ]);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "token api-key:api-secret",
    });
  });
});

function serviceRequest(token?: string): Request {
  const headers = token ? { [SERVICE_MCP_TOKEN_HEADER]: token } : undefined;
  return new Request("https://mcp.example.com/service/mcp", { method: "POST", headers });
}

function serviceToolRequest(
  token: string,
  toolName: string,
  args: Record<string, unknown>,
): Request {
  return new Request("https://mcp.example.com/service/mcp", {
    method: "POST",
    headers: {
      [SERVICE_MCP_TOKEN_HEADER]: token,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
}

function executionContext(): ExecutionContext {
  return {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
    props: Object.create(null),
  } as unknown as ExecutionContext;
}

function serviceEnv(site: SiteRecord | null): Env {
  const database = {
    prepare: () => ({
      bind: (tokenHash: unknown) => ({
        first: async () => tokenHash === site?.service_token_hash ? site : null,
      }),
    }),
  };
  return {
    ASSETS: Object.create(null) as Fetcher,
    ADMIN_TOKEN: "admin-token",
    CONFIG_ENCRYPTION_KEY: KEY,
    NEXWAVE_MCP_DB: Object.assign(Object.create(null) as D1Database, database),
    OAUTH_KV: Object.create(null) as KVNamespace,
    OAUTH_PROVIDER: Object.create(null) as Env["OAUTH_PROVIDER"],
  };
}

async function apiTokenSite(): Promise<SiteRecord> {
  return {
    id: "site_test",
    display_name: "Demo",
    base_url: "https://demo.example.com",
    auth_type: "api_token",
    client_id: null,
    encrypted_client_secret: null,
    encrypted_api_key: await encryptSecret("api-key", KEY),
    encrypted_api_secret: await encryptSecret("api-secret", KEY),
    api_user: "service@example.com",
    service_token_hash: await sha256("gateway-token"),
    enabled: 1,
    created_at: "2026-09-21 00:00:00",
    updated_at: "2026-09-21 00:00:00",
  };
}
