import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFreshToken, frappeList, getLoggedUser } from "../src/frappe";
import type { NexWaveAuthProps } from "../src/types";

const PROPS: NexWaveAuthProps = {
  siteId: "site_test",
  siteName: "Demo",
  baseUrl: "https://demo.example.com",
  user: "user@example.com",
  upstreamAccessToken: "access-token",
  upstreamRefreshToken: "refresh-token",
  upstreamExpiresAt: Date.now() + 3_600_000,
  upstreamClientId: "client-id",
  upstreamClientSecret: "client-secret",
};

afterEach(() => vi.unstubAllGlobals());

describe("Frappe REST client", () => {
  it("uses the user bearer token and bounded list parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ name: "Example" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await frappeList(PROPS, "Customer", ["name"], { limit: 100 });

    expect(result).toEqual([{ name: "Example" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("limit_page_length=50");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer access-token" });
  });

  it("reads the authenticated Frappe user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "user@example.com" }), { status: 200 }),
      ),
    );

    await expect(getLoggedUser(PROPS.baseUrl, PROPS.upstreamAccessToken)).resolves.toBe("user@example.com");
  });

  it("refreshes an expired upstream token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 1800 }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureFreshToken({ ...PROPS, upstreamExpiresAt: Date.now() - 1 });

    expect(result.upstreamAccessToken).toBe("new-token");
    expect(result.upstreamRefreshToken).toBe("new-refresh");
    const [, init] = fetchMock.mock.calls[0];
    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_secret")).toBe("client-secret");
  });
});
