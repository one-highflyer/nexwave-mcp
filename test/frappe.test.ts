import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFreshToken, frappeList, frappeRunReport, getApiTokenUser, getLoggedUser } from "../src/frappe";
import type { NexWaveApiTokenAuthProps, NexWaveOAuthAuthProps } from "../src/types";

const PROPS: NexWaveOAuthAuthProps = {
  authType: "oauth",
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

const API_TOKEN_PROPS: NexWaveApiTokenAuthProps = {
  authType: "api_token",
  siteId: "site_test",
  siteName: "Demo",
  baseUrl: "https://demo.example.com",
  user: "service@example.com",
  upstreamApiKey: "api-key",
  upstreamApiSecret: "api-secret",
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Frappe REST client", () => {
  it.each(["<html>private failure</html>", "null", "{}", "{\"data\":null}"])("does not treat invalid list data as no records: %s", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await expect(frappeList(PROPS, "Customer", ["name"])).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
  });

  it("aborts a stalled request and preserves a structured timeout error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const result = frappeList({ ...API_TOKEN_PROPS, requestDeadline: Date.now() + 8000 }, "Customer", ["name"]);
    const check = expect(result).rejects.toThrow("UPSTREAM_TIMEOUT");
    await vi.advanceTimersByTimeAsync(8000);
    await check;
  });

  it("does not start a second upstream request after the tool deadline", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(frappeList({ ...API_TOKEN_PROPS, requestDeadline: Date.now() - 1 }, "Customer", ["name"])).rejects.toThrow("UPSTREAM_TIMEOUT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a safe error for an HTML failure without exposing its body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private upstream body", { status: 502 })));
    const result = frappeList(PROPS, "Customer", ["name"]);
    await expect(result).rejects.toThrow("UPSTREAM_UNAVAILABLE");
    await expect(result).rejects.not.toThrow("private upstream body");
  });

  it("rejects unfinished reports instead of reporting zero", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: { prepared_report: true } })));
    await expect(frappeRunReport(PROPS, "Accounts Payable", {})).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
  });
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

  it("reads the Frappe user for a fixed API token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "service@example.com" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getApiTokenUser(PROPS.baseUrl, "api-key", "api-secret")).resolves.toBe(
      "service@example.com",
    );
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "token api-key:api-secret",
    });
  });

  it("uses Frappe API token authentication for service connections", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ name: "Example" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await frappeList(API_TOKEN_PROPS, "Customer", ["name"]);

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "token api-key:api-secret",
    });
  });

  it("runs an allowlisted query report with the signed-in user token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: { columns: [], result: [{ item_code: "ITEM-001" }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await frappeRunReport(PROPS, "Stock Balance", {
      company: "Example Company",
      from_date: "2026-01-01",
      to_date: "2026-01-31",
    });

    expect(result.result).toEqual([{ item_code: "ITEM-001" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://demo.example.com/api/method/frappe.desk.query_report.run");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer access-token" });
    const body = init.body as URLSearchParams;
    expect(body.get("report_name")).toBe("Stock Balance");
    expect(JSON.parse(body.get("filters") ?? "{}")).toMatchObject({ company: "Example Company" });
    expect(body.get("ignore_prepared_report")).toBe("1");
    expect(body.get("are_default_filters")).toBe("0");
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

    if (result.authType === "api_token") throw new Error("Expected OAuth authentication.");
    expect(result.upstreamAccessToken).toBe("new-token");
    expect(result.upstreamRefreshToken).toBe("new-refresh");
    const [, init] = fetchMock.mock.calls[0];
    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_secret")).toBe("client-secret");
  });

  it("does not refresh a Frappe API token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureFreshToken(API_TOKEN_PROPS)).resolves.toBe(API_TOKEN_PROPS);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
