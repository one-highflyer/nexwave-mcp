import { describe, expect, it } from "vitest";
import {
  authenticateServiceMcpRequest,
  SERVICE_MCP_TOKEN_HEADER,
} from "../src/service-mcp";
import { encryptSecret, sha256 } from "../src/security";
import type { Env, SiteRecord } from "../src/types";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("service MCP authentication", () => {
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
});

function serviceRequest(token?: string): Request {
  const headers = token ? { [SERVICE_MCP_TOKEN_HEADER]: token } : undefined;
  return new Request("https://mcp.example.com/service/mcp", { method: "POST", headers });
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
