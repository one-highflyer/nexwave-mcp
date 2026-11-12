import { Hono } from "hono";
import type { Context, Next } from "hono";
import { ADMIN_HTML } from "./admin-page";
import { createSite, deleteSite, getSiteByBaseUrl, getSite, listSites } from "./db";
import { getApiTokenUser } from "./frappe";
import { encryptSecret, randomToken, safeBaseUrl, secureEqual, sha256 } from "./security";
import type { Env, SiteAuthType, SiteRecord } from "./types";
import { WRITE_CAPABILITIES } from "./types";
import { parseWriteCapabilities } from "./write-access";

export const adminApp = new Hono<{ Bindings: Env }>();

adminApp.get("/admin", (context) => htmlResponse(ADMIN_HTML));

adminApp.get("/api/admin/sites", requireAdmin, async (context) => {
  const sites = await listSites(context.env);
  return context.json(
    sites.map((site) => ({
      id: site.id,
      displayName: site.display_name,
      baseUrl: site.base_url,
      authType: site.auth_type,
      clientId: site.client_id,
      apiUser: site.api_user,
      enabled: Boolean(site.enabled),
      createdAt: site.created_at,
      writeCapabilities: parseWriteCapabilities(site.write_capabilities),
    })),
  );
});

adminApp.post("/api/admin/sites", requireAdmin, async (context) => {
  const input = await context.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const displayName = requiredString(input.displayName, "Display name", 100);
  const baseUrl = safeBaseUrl(requiredString(input.baseUrl, "Site URL", 300));
  const authType = requiredAuthType(input.authType);
  const writeCapabilities = validatedCapabilities(input.writeCapabilities);
  if (!writeCapabilities) return context.json({ error: "Invalid write capabilities." }, 400);
  if (await getSiteByBaseUrl(context.env, baseUrl, authType)) {
    return context.json({ error: "That site URL and authentication type are already registered." }, 409);
  }

  const id = `site_${randomToken(12)}`;
  let serviceToken: string | undefined;
  let site: Omit<SiteRecord, "created_at" | "updated_at">;

  if (authType === "oauth") {
    const clientId = requiredString(input.clientId, "OAuth client ID", 200);
    const clientSecret = requiredString(input.clientSecret, "OAuth client secret", 500);
    site = {
      id,
      display_name: displayName,
      base_url: baseUrl,
      auth_type: authType,
      client_id: clientId,
      encrypted_client_secret: await encryptSecret(clientSecret, context.env.CONFIG_ENCRYPTION_KEY),
      encrypted_api_key: null,
      encrypted_api_secret: null,
      api_user: null,
      service_token_hash: null,
      enabled: 1,
      write_capabilities: JSON.stringify(writeCapabilities),
    };
  } else {
    const apiKey = requiredString(input.apiKey, "API key", 500);
    const apiSecret = requiredString(input.apiSecret, "API secret", 500);
    let apiUser: string;
    try {
      apiUser = await getApiTokenUser(baseUrl, apiKey, apiSecret);
    } catch {
      return context.json({ error: "The fixed API token could not authenticate to this NexWave site." }, 400);
    }

    serviceToken = `nwmcp_${randomToken(32)}`;
    const [encryptedApiKey, encryptedApiSecret, serviceTokenHash] = await Promise.all([
      encryptSecret(apiKey, context.env.CONFIG_ENCRYPTION_KEY),
      encryptSecret(apiSecret, context.env.CONFIG_ENCRYPTION_KEY),
      sha256(serviceToken),
    ]);
    site = {
      id,
      display_name: displayName,
      base_url: baseUrl,
      auth_type: authType,
      client_id: null,
      encrypted_client_secret: null,
      encrypted_api_key: encryptedApiKey,
      encrypted_api_secret: encryptedApiSecret,
      api_user: apiUser,
      service_token_hash: serviceTokenHash,
      enabled: 1,
      write_capabilities: JSON.stringify(writeCapabilities),
    };
  }

  try {
    await createSite(context.env, site);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint/i.test(error.message)) {
      return context.json({ error: "That site URL is already registered." }, 409);
    }
    throw error;
  }

  if (serviceToken) context.header("Cache-Control", "no-store");
  return context.json({
    id,
    displayName,
    baseUrl,
    authType,
    clientId: site.client_id,
    apiUser: site.api_user,
    serviceToken,
    enabled: true,
    writeCapabilities,
  }, 201);
});

adminApp.patch("/api/admin/sites/:id/capabilities", requireAdmin, async (context) => {
  const site = await getSite(context.env, context.req.param("id") ?? "");
  if (!site) return context.json({ error: "Site not found." }, 404);
  const input = await context.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const capabilities = validatedCapabilities(input.writeCapabilities);
  if (!capabilities || input.writeCapabilities === undefined) return context.json({ error: "Invalid write capabilities." }, 400);
  await context.env.NEXWAVE_MCP_DB.prepare("UPDATE sites SET write_capabilities = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(JSON.stringify(capabilities), site.id).run();
  return context.json({ writeCapabilities: capabilities });
});

adminApp.delete("/api/admin/sites/:id", requireAdmin, async (context) => {
  const id = context.req.param("id");
  if (!id) return context.json({ error: "Site ID is required." }, 400);
  const deleted = await deleteSite(context.env, id);
  return deleted ? context.body(null, 204) : context.json({ error: "Site not found." }, 404);
});

async function requireAdmin(context: Context<{ Bindings: Env }>, next: Next) {
  const supplied = context.req.header("Authorization");
  if (
    !context.env.ADMIN_TOKEN
    || !supplied
    || !(await secureEqual(supplied, `Bearer ${context.env.ADMIN_TOKEN}`))
  ) {
    return context.json({ error: "A valid admin token is required." }, 401);
  }
  await next();
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const result = value.trim();
  if (result.length > maxLength) throw new Error(`${label} is too long.`);
  return result;
}

function requiredAuthType(value: unknown): SiteAuthType {
  if (value === undefined) return "oauth";
  if (value === "oauth" || value === "api_token") return value;
  throw new Error("Authentication type must be OAuth or fixed API token.");
}

function validatedCapabilities(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => WRITE_CAPABILITIES.includes(entry))) return null;
  return parseWriteCapabilities(value);
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
