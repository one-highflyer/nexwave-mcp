import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  NEXWAVE_MCP_DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ADMIN_TOKEN: string;
  CONFIG_ENCRYPTION_KEY: string;
}

export interface SiteRecord {
  id: string;
  display_name: string;
  base_url: string;
  client_id: string;
  encrypted_client_secret: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface NexWaveAuthProps {
  siteId: string;
  siteName: string;
  baseUrl: string;
  user: string;
  upstreamAccessToken: string;
  upstreamRefreshToken?: string;
  upstreamExpiresAt: number;
  upstreamClientId: string;
  upstreamClientSecret: string;
}

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
