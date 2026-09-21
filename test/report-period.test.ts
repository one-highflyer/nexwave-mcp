import { afterEach, expect, it, vi } from "vitest";
import { resolveReportPeriod } from "../src/report-period";
import type { NexWaveApiTokenAuthProps } from "../src/types";
const props: NexWaveApiTokenAuthProps = { authType: "api_token", siteId: "test", siteName: "Example", baseUrl: "https://example.com", user: "test@example.com", upstreamApiKey: "key", upstreamApiSecret: "secret" };
afterEach(() => vi.unstubAllGlobals());

it("uses the requested company's fiscal year and the supplied local calendar date", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ message: ["FY-TEST", "2026-07-01", "2027-06-30"] }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await resolveReportPeriod(props, "Example", { as_of_date: "2026-09-21" })).toEqual({ from_date: "2026-07-01", to_date: "2026-09-21", fiscal_year: "FY-TEST" });
  const url = new URL(String(fetchMock.mock.calls[0][0]));
  expect(url.searchParams.get("company")).toBe("Example");
  expect(url.searchParams.get("date")).toBe("2026-09-21");
});

it("handles leap-year month ends and calendar-year transitions", async () => {
  expect(await resolveReportPeriod(props, "Example", { period: "last_month", as_of_date: "2024-03-15" })).toMatchObject({ from_date: "2024-02-01", to_date: "2024-02-29" });
  expect(await resolveReportPeriod(props, "Example", { period: "last_month", as_of_date: "2026-01-15" })).toMatchObject({ from_date: "2025-12-01", to_date: "2025-12-31" });
  expect(await resolveReportPeriod(props, "Example", { period: "last_90_days", as_of_date: "2026-03-31" })).toMatchObject({ from_date: "2026-01-01", to_date: "2026-03-31" });
});

it("preserves explicit date calls and rejects mixed or missing dates", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  expect(await resolveReportPeriod(props, "Example", { from_date: "2026-01-01", to_date: "2026-03-31" })).toMatchObject({ from_date: "2026-01-01", to_date: "2026-03-31" });
  await expect(resolveReportPeriod(props, "Example", {})).rejects.toThrow("INVALID_ARGUMENT");
  await expect(resolveReportPeriod(props, "Example", { as_of_date: "2026-02-30" })).rejects.toThrow("INVALID_ARGUMENT");
  await expect(resolveReportPeriod(props, "Example", { from_date: "2026-01-01", to_date: "2026-03-31", period: "last_month" })).rejects.toThrow("INVALID_ARGUMENT");
  expect(fetchMock).not.toHaveBeenCalled();
});
