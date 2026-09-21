import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureFreshToken,
  exchangeFrappeCode,
  frappeGet,
  frappeList,
  frappeRunReport,
  getApiTokenUser,
  getLoggedUser,
} from "../src/frappe";
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

  it.each([
    ["null row", [null]],
    ["array row", [[]]],
    ["scalar row", ["CUS-001"]],
    ["missing name", [{}]],
    ["empty name", [{ name: "" }]],
    ["blank name", [{ name: "   " }]],
  ])("rejects a malformed record list with a %s", async (_label, data) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data })));
    await expect(frappeList(PROPS, "Customer", ["name"])).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
  });

  it("allows object rows without name when name was not requested", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{ count: 1 }] })));
    await expect(frappeList(PROPS, "Example", ["count"])).resolves.toEqual([{ count: 1 }]);
  });

  it.each([null, [], "Customer", 1])("rejects malformed document data: %j", async (data) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data })));
    await expect(frappeGet(PROPS, "Customer", "CUS-001")).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
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

  it("maps a permission failure safely and cancels its unread body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("private permission detail")); },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 403 })));

    const result = frappeList(PROPS, "Customer", ["name"]);
    await expect(result).rejects.toThrow("PERMISSION_DENIED");
    await expect(result).rejects.not.toThrow("private permission detail");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects unfinished reports instead of reporting zero", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: { prepared_report: true } })));
    await expect(frappeRunReport(PROPS, "Accounts Payable", {})).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
  });

  it.each([null, [], "total", 1])("rejects a malformed report row: %j", async (row) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: { result: [row] } })));
    await expect(frappeRunReport(PROPS, "Accounts Payable", {})).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
  });

  it("normalises a Frappe array total row using the report columns", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: {
      columns: [{ fieldname: "party" }, { fieldname: "outstanding" }],
      add_total_row: 1,
      result: [
        { party: "SUP-001", voucher_no: "PINV-001", outstanding: 125 },
        ["Total", 125],
      ],
    } })));

    await expect(frappeRunReport(PROPS, "Accounts Payable", {})).resolves.toMatchObject({
      result: [
        { party: "SUP-001", voucher_no: "PINV-001", outstanding: 125 },
        { party: "Total", outstanding: 125, is_total_row: true },
      ],
    });
  });

  it.each([
    ["missing columns", undefined, ["Total"]],
    ["missing fieldname", [{}], ["Total"]],
    ["too many values", [{ fieldname: "party" }], ["Total", 125]],
  ])("rejects an array report row with %s", async (_label, columns, row) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: { columns, result: [row] } })));
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
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("aborts a stalled OAuth refresh within the remaining request budget", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted();
        reject(new DOMException("Aborted", "AbortError"));
      });
    })));
    const result = ensureFreshToken({
      ...PROPS,
      upstreamExpiresAt: Date.now() - 1,
      requestDeadline: Date.now() + 2_000,
    });
    const check = expect(result).rejects.toThrow("UPSTREAM_TIMEOUT");

    await vi.advanceTimersByTimeAsync(2_000);

    await check;
    expect(aborted).toHaveBeenCalledOnce();
  });

  it.each([
    ["invalid JSON", "<html>private failure</html>"],
    ["null body", "null"],
    ["missing token", "{}"],
    ["empty token", "{\"access_token\":\"\"}"],
    ["padded access token", "{\"access_token\":\" new-token \"}"],
    ["empty refresh token", "{\"access_token\":\"new-token\",\"refresh_token\":\"\"}"],
    ["padded refresh token", "{\"access_token\":\"new-token\",\"refresh_token\":\" new-refresh \"}"],
    ["invalid expiry", "{\"access_token\":\"new-token\",\"expires_in\":{}}"],
  ])("rejects a malformed OAuth token response with an %s", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const result = ensureFreshToken({ ...PROPS, upstreamExpiresAt: Date.now() - 1 });
    await expect(result).rejects.toThrow("UPSTREAM_INVALID_RESPONSE");
    await expect(result).rejects.not.toThrow("private failure");
  });

  it("cancels an oversized OAuth token body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    await expect(ensureFreshToken({ ...PROPS, upstreamExpiresAt: Date.now() - 1 })).rejects.toThrow("RESULT_TOO_LARGE");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not read or expose an OAuth permission error body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("private OAuth detail")); },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 403 })));

    const result = ensureFreshToken({ ...PROPS, upstreamExpiresAt: Date.now() - 1 });
    await expect(result).rejects.toThrow("AUTHENTICATION_REQUIRED");
    await expect(result).rejects.not.toThrow("private OAuth detail");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses bounded OAuth code exchange without sending an authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ access_token: "new-token", expires_in: 1800 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeFrappeCode({
      baseUrl: PROPS.baseUrl,
      clientId: PROPS.upstreamClientId,
      clientSecret: PROPS.upstreamClientSecret,
      code: "authorization-code",
      codeVerifier: "code-verifier",
      redirectUri: "https://gateway.example.com/oauth/frappe/callback",
    })).resolves.toMatchObject({ access_token: "new-token" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).not.toHaveProperty("Authorization");
    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("code-verifier");
  });

  it("does not refresh a Frappe API token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureFreshToken(API_TOKEN_PROPS)).resolves.toBe(API_TOKEN_PROPS);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
