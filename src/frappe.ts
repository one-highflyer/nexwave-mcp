import type { NexWaveAuthProps, NexWaveOAuthAuthProps } from "./types";
import { ToolError } from "./tool-result";

export const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_READ_ATTEMPTS = 2;
const MIN_RETRY_BUDGET_MS = 250;

interface FrappeEnvelope<T> {
  data?: T;
  message?: T;
  exc_type?: string;
  exception?: string;
}

export interface FrappeReportColumn {
  fieldname?: string;
  label?: string;
  fieldtype?: string;
  options?: string;
  width?: number;
  [key: string]: unknown;
}

export interface FrappeReportResult {
  result?: Array<Record<string, unknown>>;
  columns?: FrappeReportColumn[];
  report_summary?: Array<Record<string, unknown>>;
  execution_time?: number;
  add_total_row?: boolean | number;
}

export interface UpstreamTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export async function exchangeFrappeCode(input: {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<UpstreamTokenResponse> {
  return requestToken(input.baseUrl, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  });
}

export async function refreshFrappeToken(props: NexWaveOAuthAuthProps): Promise<NexWaveOAuthAuthProps> {
  if (!props.upstreamRefreshToken) throw new Error("The NexWave session cannot be refreshed. Sign in again.");
  const token = await requestToken(props.baseUrl, {
    grant_type: "refresh_token",
    refresh_token: props.upstreamRefreshToken,
    client_id: props.upstreamClientId,
    client_secret: props.upstreamClientSecret,
  }, Math.min(UPSTREAM_TIMEOUT_MS, remainingTime(props)));
  return {
    ...props,
    upstreamAccessToken: token.access_token,
    upstreamRefreshToken: token.refresh_token ?? props.upstreamRefreshToken,
    upstreamExpiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
  };
}

export async function getLoggedUser(baseUrl: string, accessToken: string): Promise<string> {
  return getLoggedUserWithAuthorization(baseUrl, `Bearer ${accessToken}`);
}

export async function getApiTokenUser(baseUrl: string, apiKey: string, apiSecret: string): Promise<string> {
  return getLoggedUserWithAuthorization(baseUrl, `token ${apiKey}:${apiSecret}`);
}

async function getLoggedUserWithAuthorization(baseUrl: string, authorization: string): Promise<string> {
  const response = await frappeFetch<{ message: string }>(
    `${baseUrl}/api/method/frappe.auth.get_logged_user`,
    authorization,
  );
  if (!response.message || typeof response.message !== "string") {
    throw new Error("NexWave did not return the signed-in user.");
  }
  return response.message;
}

export async function frappeList<T>(
  props: NexWaveAuthProps,
  doctype: string,
  fields: string[],
  options: { limit?: number; filters?: unknown[]; orFilters?: unknown[]; orderBy?: string } = {},
): Promise<T[]> {
  const url = new URL(`/api/resource/${encodeURIComponent(doctype)}`, props.baseUrl);
  url.searchParams.set("fields", JSON.stringify(fields));
  url.searchParams.set("limit_page_length", String(Math.min(Math.max(options.limit ?? 20, 1), 50)));
  if (options.filters?.length) url.searchParams.set("filters", JSON.stringify(options.filters));
  if (options.orFilters?.length) url.searchParams.set("or_filters", JSON.stringify(options.orFilters));
  if (options.orderBy) url.searchParams.set("order_by", options.orderBy);
  const response = await frappeFetch<FrappeEnvelope<T[]>>(url.toString(), upstreamAuthorization(props), {}, remainingTime(props));
  const requiresName = fields.includes("name");
  if (!Array.isArray(response.data) || !response.data.every((row) => isRecord(row)
    && (!requiresName || (typeof row.name === "string" && Boolean(row.name.trim()))))) {
    throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave did not return a valid record list.");
  }
  return response.data as T[];
}

export async function frappeGet<T>(props: NexWaveAuthProps, doctype: string, name: string): Promise<T> {
  const url = new URL(`/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, props.baseUrl);
  const response = await frappeFetch<FrappeEnvelope<T>>(url.toString(), upstreamAuthorization(props), {}, remainingTime(props));
  if (!isRecord(response.data)) {
    throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave did not return a valid record.");
  }
  return response.data as T;
}

export async function frappeRunReport(
  props: NexWaveAuthProps,
  reportName: string,
  filters: Record<string, unknown>,
): Promise<FrappeReportResult> {
  const url = new URL("/api/method/frappe.desk.query_report.run", props.baseUrl);
  const body = new URLSearchParams({
    report_name: reportName,
    filters: JSON.stringify(filters),
    ignore_prepared_report: "1",
    are_default_filters: "0",
  });
  const response = await frappeFetch<FrappeEnvelope<FrappeReportResult>>(
    url.toString(),
    upstreamAuthorization(props),
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
    remainingTime(props),
  );
  if (!response.message || !Array.isArray(response.message.result)) {
    throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave did not return a completed report. No balance can be inferred.");
  }
  return {
    ...response.message,
    result: normaliseReportRows(
      response.message.result,
      response.message.columns,
      Boolean(response.message.add_total_row),
    ),
  };
}

export async function frappeFiscalYear(props: NexWaveAuthProps, company: string, date: string, fiscalYear?: string) {
  const url = new URL("/api/method/erpnext.accounts.utils.get_fiscal_year", props.baseUrl);
  url.searchParams.set("company", company);
  // Frappe matches the date OR the name, so never send both selectors.
  url.searchParams.set(fiscalYear ? "fiscal_year" : "date", fiscalYear ?? date);
  const response = await frappeFetch<{ message?: unknown }>(url.toString(), upstreamAuthorization(props), {}, remainingTime(props));
  if (!Array.isArray(response.message) || response.message.length !== 3 || !response.message.every((value) => typeof value === "string")) {
    throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave did not return a fiscal year for the company and date.");
  }
  const [name, from_date, to_date] = response.message as string[];
  if (!name || ![from_date, to_date].every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value) || from_date > to_date || (fiscalYear && name !== fiscalYear)) {
    throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned an invalid fiscal year.");
  }
  return { name, from_date, to_date };
}

export async function ensureFreshToken(props: NexWaveAuthProps): Promise<NexWaveAuthProps> {
  if (props.authType === "api_token") return props;
  if (props.upstreamExpiresAt > Date.now() + 30_000) return props;
  return refreshFrappeToken(props);
}

async function requestToken(
  baseUrl: string,
  values: Record<string, string>,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<UpstreamTokenResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/method/frappe.integrations.oauth2.get_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(values),
      // Workers supports manual redirects, not the browser's error mode.
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400) {
        throw new ToolError("UPSTREAM_UNAVAILABLE", "NexWave OAuth returned a redirect. Check the registered site URL.");
      }
      if ([400, 401, 403].includes(response.status)) {
        throw new ToolError("AUTHENTICATION_REQUIRED", "The NexWave connection needs to be authenticated again.");
      }
      throw new ToolError("UPSTREAM_UNAVAILABLE", `NexWave OAuth returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
    }
    const payload = await readBoundedJson(response);
    if (!isRecord(payload)
      || typeof payload.access_token !== "string"
      || !payload.access_token.trim()
      || payload.access_token !== payload.access_token.trim()
      || (payload.refresh_token !== undefined && (typeof payload.refresh_token !== "string"
        || !payload.refresh_token.trim()
        || payload.refresh_token !== payload.refresh_token.trim()))
      || (payload.expires_in !== undefined && (typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0))
      || (payload.token_type !== undefined && typeof payload.token_type !== "string")) {
      throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave OAuth returned an invalid token response.");
    }
    return payload as unknown as UpstreamTokenResponse;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ToolError("UPSTREAM_TIMEOUT", "NexWave OAuth did not respond in time.", true);
    }
    if (error instanceof ToolError) throw error;
    throw new ToolError("UPSTREAM_UNAVAILABLE", "The NexWave OAuth request failed. Please try again later.", true);
  } finally {
    clearTimeout(timer);
  }
}

function upstreamAuthorization(props: NexWaveAuthProps): string {
  if (props.authType === "api_token") {
    return `token ${props.upstreamApiKey}:${props.upstreamApiSecret}`;
  }
  return `Bearer ${props.upstreamAccessToken}`;
}

function remainingTime(props: NexWaveAuthProps): number {
  const remaining = props.requestDeadline === undefined ? 50_000 : props.requestDeadline - Date.now();
  if (remaining <= 0) throw new ToolError("UPSTREAM_TIMEOUT", "The request time limit was reached. Please try again later.", true);
  return remaining;
}

async function frappeFetch<T>(url: string, authorization: string, init: RequestInit = {}, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const requestId = crypto.randomUUID();
  let lastError: ToolError | undefined;
  for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      return await frappeFetchAttempt<T>(url, authorization, init, remainingMs, requestId, attempt);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      lastError = error;
      const retryBudgetMs = deadline - Date.now();
      if (!error.retryable || attempt >= MAX_READ_ATTEMPTS || retryBudgetMs < MIN_RETRY_BUDGET_MS) throw error;
      console.warn(JSON.stringify({
        event: "frappe_request_retry",
        request_id: requestId,
        completed_attempt: attempt,
        next_attempt: attempt + 1,
        remaining_ms: retryBudgetMs,
        code: error.code,
      }));
    }
  }
  throw lastError ?? new ToolError("UPSTREAM_TIMEOUT", "The request time limit was reached. Please try again later.", true);
}

async function frappeFetchAttempt<T>(
  url: string,
  authorization: string,
  init: RequestInit,
  timeoutMs: number,
  requestId: string,
  attempt: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let status: number | undefined;
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "manual",
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400) {
        throw new ToolError("UPSTREAM_UNAVAILABLE", "NexWave returned a redirect. Check the registered site URL.");
      }
      if (response.status === 401) {
        throw new ToolError("AUTHENTICATION_REQUIRED", "The NexWave connection needs to be authenticated again.");
      }
      if (response.status === 403) {
        throw new ToolError("PERMISSION_DENIED", "The signed-in NexWave user does not have permission for this request.");
      }
      if (response.status === 404) {
        throw new ToolError("NOT_FOUND", "The requested NexWave resource was not found.");
      }
      throw new ToolError("UPSTREAM_UNAVAILABLE", `NexWave returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
    }
    const payload = await readBoundedJson(response);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned an invalid response. This does not mean there are no records.");
    }
    return payload as T;
  } catch (error) {
    const safe = controller.signal.aborted
      ? new ToolError("UPSTREAM_TIMEOUT", "NexWave did not respond in time. Do not treat this as no matching records.", true)
      : error instanceof ToolError ? error
      : new ToolError("UPSTREAM_UNAVAILABLE", "The NexWave request failed. Please try again later.", true);
    console.warn(JSON.stringify({ event: "frappe_request_failed", request_id: requestId, attempt, duration_ms: Date.now() - started, status, code: safe.code }));
    throw safe;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned an empty response.");
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ToolError("RESULT_TOO_LARGE", "The result is too large. Use a narrower date range or more filters.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned invalid JSON. This does not mean there are no records.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseReportRows(
  rows: unknown[],
  columns: FrappeReportColumn[] | undefined,
  hasTotalRow: boolean,
): Array<Record<string, unknown>> {
  return rows.map((row, rowIndex) => {
    if (isRecord(row)) return row;
    if (!Array.isArray(row) || !Array.isArray(columns) || row.length > columns.length) {
      throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned an invalid report row. No balance can be inferred.");
    }
    const record: Record<string, unknown> = {};
    for (let index = 0; index < row.length; index++) {
      const column = columns[index];
      if (!isRecord(column) || typeof column.fieldname !== "string" || !column.fieldname.trim()) {
        throw new ToolError("UPSTREAM_INVALID_RESPONSE", "NexWave returned invalid report columns. No balance can be inferred.");
      }
      record[column.fieldname] = row[index];
    }
    if (hasTotalRow && rowIndex === rows.length - 1) record.is_total_row = true;
    return record;
  });
}
