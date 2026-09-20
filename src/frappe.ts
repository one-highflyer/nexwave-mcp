import type { NexWaveAuthProps } from "./types";

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

export async function refreshFrappeToken(props: NexWaveAuthProps): Promise<NexWaveAuthProps> {
  if (!props.upstreamRefreshToken) throw new Error("The NexWave session cannot be refreshed. Sign in again.");
  const token = await requestToken(props.baseUrl, {
    grant_type: "refresh_token",
    refresh_token: props.upstreamRefreshToken,
    client_id: props.upstreamClientId,
    client_secret: props.upstreamClientSecret,
  });
  return {
    ...props,
    upstreamAccessToken: token.access_token,
    upstreamRefreshToken: token.refresh_token ?? props.upstreamRefreshToken,
    upstreamExpiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
  };
}

export async function getLoggedUser(baseUrl: string, accessToken: string): Promise<string> {
  const response = await frappeFetch<{ message: string }>(
    `${baseUrl}/api/method/frappe.auth.get_logged_user`,
    accessToken,
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
  const response = await frappeFetch<FrappeEnvelope<T[]>>(url.toString(), props.upstreamAccessToken);
  return response.data ?? [];
}

export async function frappeGet<T>(props: NexWaveAuthProps, doctype: string, name: string): Promise<T> {
  const url = new URL(`/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, props.baseUrl);
  const response = await frappeFetch<FrappeEnvelope<T>>(url.toString(), props.upstreamAccessToken);
  if (!response.data) throw new Error(`${doctype} ${name} was not found.`);
  return response.data;
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
    props.upstreamAccessToken,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
  );
  if (!response.message) throw new Error(`${reportName} did not return report data.`);
  return response.message;
}

export async function ensureFreshToken(props: NexWaveAuthProps): Promise<NexWaveAuthProps> {
  if (props.upstreamExpiresAt > Date.now() + 30_000) return props;
  return refreshFrappeToken(props);
}

async function requestToken(baseUrl: string, values: Record<string, string>): Promise<UpstreamTokenResponse> {
  const response = await fetch(`${baseUrl}/api/method/frappe.integrations.oauth2.get_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(values),
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<UpstreamTokenResponse> & { error_description?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || `NexWave OAuth returned HTTP ${response.status}.`);
  }
  return payload as UpstreamTokenResponse;
}

async function frappeFetch<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T & FrappeEnvelope<unknown>;
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error("The signed-in NexWave user does not have permission for this request.");
    }
    if (response.status === 404) {
      throw new Error("The requested NexWave resource was not found.");
    }
    const type = payload.exc_type ? ` (${payload.exc_type})` : "";
    throw new Error(`NexWave returned HTTP ${response.status}${type}.`);
  }
  return payload;
}
