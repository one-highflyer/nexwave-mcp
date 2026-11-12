import { getSite } from "./db";
import { ToolError } from "./tool-result";
import { WRITE_CAPABILITIES, type Env, type NexWaveAuthProps, type WriteCapability } from "./types";

export const WRITE_SCOPES = WRITE_CAPABILITIES.map((value) => `nexwave:write:${value}`);

export function parseWriteCapabilities(value: unknown): WriteCapability[] {
  let values: unknown = value;
  if (typeof value === "string") {
    try { values = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(values)) return [];
  return WRITE_CAPABILITIES.filter((value) => values.includes(value));
}

export function grantedWriteCapabilities(scopes: string[], configured: unknown): WriteCapability[] {
  return parseWriteCapabilities(configured).filter((value) => scopes.includes(`nexwave:write:${value}`));
}

export async function requireWriteAccess(env: Env | undefined, props: NexWaveAuthProps, capability: WriteCapability): Promise<Env> {
  if (!env?.NEXWAVE_MCP_DB || !props.writeCapabilities?.includes(capability)) {
    throw new ToolError("PERMISSION_DENIED", "This connection has not been granted this write capability. Ask the administrator to enable it and reconnect.");
  }
  // Recheck configuration on every write. Revoking access does not wait for an OAuth token to expire.
  const site = await getSite(env, props.siteId);
  if (!site?.enabled || site.base_url !== props.baseUrl || site.auth_type !== (props.authType ?? "oauth")
    || !parseWriteCapabilities(site.write_capabilities).includes(capability)) {
    throw new ToolError("PERMISSION_DENIED", "This write capability is disabled for the connection.");
  }
  return env;
}
