import { afterEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin";
import { decryptSecret, sha256 } from "../src/security";
import type { Env } from "../src/types";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

afterEach(() => vi.unstubAllGlobals());

describe("admin site authentication modes", () => {
  it("renders OAuth and fixed-token setup options", async () => {
    const response = await adminApp.request("/admin");
    const html = await response.text();

    expect(html).toContain('id="auth-type"');
    expect(html).toContain('value="oauth"');
    expect(html).toContain('value="api_token"');
    expect(html).toContain('id="service-token-panel"');
  });

  it("verifies and stores a fixed API token, then returns a one-time service token", async () => {
    const inserted: unknown[][] = [];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "service@example.com" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await addSite(
      {
        displayName: "Demo",
        baseUrl: "https://demo.example.com",
        authType: "api_token",
        apiKey: "api-key",
        apiSecret: "api-secret",
      },
      adminEnv(inserted),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = await response.json<{ serviceToken: string; apiUser: string }>();
    expect(result.apiUser).toBe("service@example.com");
    expect(result.serviceToken).toMatch(/^nwmcp_/);
    expect(inserted).toHaveLength(1);
    const values = inserted[0];
    expect(values[3]).toBe("api_token");
    expect(values[4]).toBeNull();
    expect(values[5]).toBeNull();
    expect(values[8]).toBe("service@example.com");
    expect(values[9]).toBe(await sha256(result.serviceToken));
    await expect(decryptSecret(String(values[6]), KEY)).resolves.toBe("api-key");
    await expect(decryptSecret(String(values[7]), KEY)).resolves.toBe("api-secret");
  });

  it("keeps the existing OAuth request and response contract", async () => {
    const inserted: unknown[][] = [];
    const response = await addSite(
      {
        displayName: "Demo",
        baseUrl: "https://demo.example.com",
        clientId: "oauth-client-id",
        clientSecret: "oauth-client-secret",
      },
      adminEnv(inserted),
    );

    expect(response.status).toBe(201);
    const result = await response.json<Record<string, unknown>>();
    expect(result).toMatchObject({
      displayName: "Demo",
      baseUrl: "https://demo.example.com",
      authType: "oauth",
      clientId: "oauth-client-id",
      apiUser: null,
      enabled: true,
    });
    expect(result).not.toHaveProperty("serviceToken");
    const values = inserted[0];
    expect(values[3]).toBe("oauth");
    expect(values[4]).toBe("oauth-client-id");
    await expect(decryptSecret(String(values[5]), KEY)).resolves.toBe("oauth-client-secret");
    expect(values.slice(6, 10)).toEqual([null, null, null, null]);
  });
});

async function addSite(body: Record<string, unknown>, env: Env): Promise<Response> {
  return adminApp.request(
    "/api/admin/sites",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

function adminEnv(inserted: unknown[][]): Env {
  const database = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => null,
            run: async () => {
              if (query.includes("INSERT INTO sites")) inserted.push(values);
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
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
