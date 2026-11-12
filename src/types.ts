import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  ASSETS: Fetcher;
  NEXWAVE_MCP_DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ADMIN_TOKEN: string;
  CONFIG_ENCRYPTION_KEY: string;
}

export type SiteAuthType = "oauth" | "api_token";
export const WRITE_CAPABILITIES = ["quotations", "leads", "customers", "sales_orders", "purchase_invoices", "submissions"] as const;
export type WriteCapability = typeof WRITE_CAPABILITIES[number];
export const SUBMITTABLE_DOCTYPES = ["Quotation", "Sales Order", "Purchase Invoice"] as const;
export type SubmittableDoctype = typeof SUBMITTABLE_DOCTYPES[number];

export interface SiteRecord {
  id: string;
  display_name: string;
  base_url: string;
  auth_type: SiteAuthType;
  client_id: string | null;
  encrypted_client_secret: string | null;
  encrypted_api_key: string | null;
  encrypted_api_secret: string | null;
  api_user: string | null;
  service_token_hash: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  /** Missing on legacy fixtures; migration defaults all existing connections to read-only. */
  write_capabilities?: string;
}

interface NexWaveAuthPropsBase {
  /** Per-tool deadline, created after authentication; never stored in site configuration. */
  requestDeadline?: number;
  siteId: string;
  siteName: string;
  baseUrl: string;
  user: string;
  writeCapabilities?: WriteCapability[];
}

export interface NexWaveOAuthAuthProps extends NexWaveAuthPropsBase {
  authType?: "oauth";
  upstreamAccessToken: string;
  upstreamRefreshToken?: string;
  upstreamExpiresAt: number;
  upstreamClientId: string;
  upstreamClientSecret: string;
}

export interface NexWaveApiTokenAuthProps extends NexWaveAuthPropsBase {
  authType: "api_token";
  upstreamApiKey: string;
  upstreamApiSecret: string;
}

export type NexWaveAuthProps = NexWaveOAuthAuthProps | NexWaveApiTokenAuthProps;

export interface PendingAuthorization {
  oauthRequest: AuthRequest;
  csrfTokenHash: string;
  createdAt: number;
}

export interface PendingFrappeAuthorization {
  oauthRequest: AuthRequest;
  siteId: string;
  browserTokenHash: string;
  codeVerifier: string;
  createdAt: number;
}
