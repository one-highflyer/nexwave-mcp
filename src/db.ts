import type { Env, SiteRecord } from "./types";

export async function listSites(env: Env, enabledOnly = false): Promise<SiteRecord[]> {
  const where = enabledOnly ? " WHERE enabled = 1" : "";
  const result = await env.NEXWAVE_MCP_DB.prepare(
    `SELECT id, display_name, base_url, client_id, encrypted_client_secret, enabled, created_at, updated_at FROM sites${where} ORDER BY display_name`,
  ).all<SiteRecord>();
  return result.results;
}

export async function getSite(env: Env, id: string): Promise<SiteRecord | null> {
  return env.NEXWAVE_MCP_DB.prepare(
    "SELECT id, display_name, base_url, client_id, encrypted_client_secret, enabled, created_at, updated_at FROM sites WHERE id = ?",
  )
    .bind(id)
    .first<SiteRecord>();
}

export async function getSiteByBaseUrl(env: Env, baseUrl: string): Promise<SiteRecord | null> {
  return env.NEXWAVE_MCP_DB.prepare(
    "SELECT id, display_name, base_url, client_id, encrypted_client_secret, enabled, created_at, updated_at FROM sites WHERE base_url = ?",
  )
    .bind(baseUrl)
    .first<SiteRecord>();
}

export async function createSite(env: Env, site: Omit<SiteRecord, "created_at" | "updated_at">): Promise<void> {
  await env.NEXWAVE_MCP_DB.prepare(
    "INSERT INTO sites (id, display_name, base_url, client_id, encrypted_client_secret, enabled) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(site.id, site.display_name, site.base_url, site.client_id, site.encrypted_client_secret, site.enabled)
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
