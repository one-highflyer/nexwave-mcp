import type { Env, SiteAuthType, SiteRecord } from "./types";

const SITE_FIELDS = `id, display_name, base_url, auth_type, client_id, encrypted_client_secret,
  encrypted_api_key, encrypted_api_secret, api_user, service_token_hash, enabled, created_at, updated_at`;

export async function listSites(env: Env, enabledOnly = false): Promise<SiteRecord[]> {
  const where = enabledOnly ? " WHERE enabled = 1" : "";
  const result = await env.NEXWAVE_MCP_DB.prepare(
    `SELECT ${SITE_FIELDS} FROM sites${where} ORDER BY display_name`,
  ).all<SiteRecord>();
  return result.results;
}

export async function getSite(env: Env, id: string): Promise<SiteRecord | null> {
  return env.NEXWAVE_MCP_DB.prepare(
    `SELECT ${SITE_FIELDS} FROM sites WHERE id = ?`,
  )
    .bind(id)
    .first<SiteRecord>();
}

export async function getSiteByBaseUrl(
  env: Env,
  baseUrl: string,
  authType: SiteAuthType,
): Promise<SiteRecord | null> {
  return env.NEXWAVE_MCP_DB.prepare(
    `SELECT ${SITE_FIELDS} FROM sites WHERE base_url = ? AND auth_type = ?`,
  )
    .bind(baseUrl, authType)
    .first<SiteRecord>();
}

export async function getSiteByServiceTokenHash(env: Env, tokenHash: string): Promise<SiteRecord | null> {
  return env.NEXWAVE_MCP_DB.prepare(
    `SELECT ${SITE_FIELDS} FROM sites WHERE service_token_hash = ?`,
  )
    .bind(tokenHash)
    .first<SiteRecord>();
}

export async function createSite(env: Env, site: Omit<SiteRecord, "created_at" | "updated_at">): Promise<void> {
  await env.NEXWAVE_MCP_DB.prepare(
    `INSERT INTO sites (
      id, display_name, base_url, auth_type, client_id, encrypted_client_secret,
      encrypted_api_key, encrypted_api_secret, api_user, service_token_hash, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      site.id,
      site.display_name,
      site.base_url,
      site.auth_type,
      site.client_id,
      site.encrypted_client_secret,
      site.encrypted_api_key,
      site.encrypted_api_secret,
      site.api_user,
      site.service_token_hash,
      site.enabled,
    )
    .run();
}

export async function deleteSite(env: Env, id: string): Promise<boolean> {
  const result = await env.NEXWAVE_MCP_DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function audit(
  env: Env,
  eventType: string,
  siteId?: string,
  userId?: string,
  detail?: string,
): Promise<void> {
  await env.NEXWAVE_MCP_DB.prepare(
    "INSERT INTO audit_events (event_type, site_id, user_id, detail) VALUES (?, ?, ?, ?)",
  )
    .bind(eventType, siteId ?? null, userId ?? null, detail ?? null)
    .run();
}
