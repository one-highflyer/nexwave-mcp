import {
  AuthorizationError,
  GrantType,
  type AuthRequest,
  type ClientInfo,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { audit, getSite, listSites } from "./db";
import { exchangeFrappeCode, getLoggedUser, refreshFrappeToken } from "./frappe";
import {
  clearCookie,
  cookieName,
  decryptSecret,
  escapeHtml,
  getCookie,
  makeCookie,
  pkceChallenge,
  randomToken,
  sha256,
} from "./security";
import type { Env, NexWaveAuthProps, PendingAuthorization, PendingFrappeAuthorization } from "./types";

const AUTH_TTL_SECONDS = 600;
const LOCAL_SCOPE = "nexwave:read";

export const authApp = new Hono<{ Bindings: Env }>();

authApp.get("/", (context) => context.redirect("/admin", 302));
authApp.get("/health", (context) => context.json({ ok: true, service: "nexwave-mcp" }));

authApp.get("/authorize", async (context) => {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await context.env.OAUTH_PROVIDER.parseAuthRequest(context.req.raw);
  } catch (error) {
    return authorizationErrorResponse(error);
  }

  const [client, sites] = await Promise.all([
    context.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId),
    listSites(context.env, true),
  ]);
  if (!client) return new Response("Unknown OAuth client.", { status: 400 });

  const pendingId = randomToken();
  const csrfToken = randomToken();
  const pending: PendingAuthorization = {
    oauthRequest,
    csrfTokenHash: await sha256(csrfToken),
    createdAt: Date.now(),
  };
  await context.env.OAUTH_KV.put(`nexwave:pending:${pendingId}`, JSON.stringify(pending), {
    expirationTtl: AUTH_TTL_SECONDS,
  });

  return htmlResponse(renderConsent(client, oauthRequest, sites, pendingId, csrfToken));
});

authApp.post("/authorize", async (context) => {
  const form = await context.req.formData();
  const pendingId = formValue(form, "pending_id");
  const csrfToken = formValue(form, "csrf_token");
  const stored = await context.env.OAUTH_KV.get<PendingAuthorization>(`nexwave:pending:${pendingId}`, "json");
  if (!stored || (await sha256(csrfToken)) !== stored.csrfTokenHash) {
    return new Response("The approval request has expired or is invalid.", { status: 400 });
  }
  await context.env.OAUTH_KV.delete(`nexwave:pending:${pendingId}`);

  if (form.get("decision") !== "approve") {
    return oauthDeniedResponse(stored.oauthRequest);
  }

  const siteId = formValue(form, "site_id");
  const site = await getSite(context.env, siteId);
  if (!site || !site.enabled) return new Response("The selected NexWave site is not available.", { status: 400 });

  const state = randomToken();
  const browserToken = randomToken();
  const codeVerifier = randomToken(64);
  const upstream: PendingFrappeAuthorization = {
    oauthRequest: stored.oauthRequest,
    siteId,
    browserTokenHash: await sha256(browserToken),
    codeVerifier,
    createdAt: Date.now(),
  };
  await context.env.OAUTH_KV.put(`nexwave:frappe:${state}`, JSON.stringify(upstream), {
    expirationTtl: AUTH_TTL_SECONDS,
  });

  const authorizeUrl = new URL("/api/method/frappe.integrations.oauth2.authorize", site.base_url);
  authorizeUrl.searchParams.set("client_id", site.client_id);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl(context.req.raw));
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "all openid");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", await pkceChallenge(codeVerifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl.toString(), "Set-Cookie": makeCookie(context.req.raw, browserToken) },
  });
});

authApp.get("/oauth/frappe/callback", async (context) => {
  const state = context.req.query("state") ?? "";
  const code = context.req.query("code") ?? "";
  const upstreamError = context.req.query("error");
  const stored = state
    ? await context.env.OAUTH_KV.get<PendingFrappeAuthorization>(`nexwave:frappe:${state}`, "json")
    : null;
  if (!stored) return new Response("The NexWave sign-in request has expired or is invalid.", { status: 400 });

  const browserToken = getCookie(context.req.raw, cookieName(context.req.raw));
  if (!browserToken || (await sha256(browserToken)) !== stored.browserTokenHash) {
    return new Response("The browser session does not match this sign-in request.", { status: 400 });
  }
  await context.env.OAUTH_KV.delete(`nexwave:frappe:${state}`);

  if (upstreamError || !code) {
    return oauthDeniedResponse(stored.oauthRequest, upstreamError ?? "access_denied");
  }

  const site = await getSite(context.env, stored.siteId);
  if (!site || !site.enabled) return new Response("The selected NexWave site is not available.", { status: 400 });

  try {
    const clientSecret = await decryptSecret(site.encrypted_client_secret, context.env.CONFIG_ENCRYPTION_KEY);
    const token = await exchangeFrappeCode({
      baseUrl: site.base_url,
      clientId: site.client_id,
      clientSecret,
      code,
      codeVerifier: stored.codeVerifier,
      redirectUri: callbackUrl(context.req.raw),
    });
    const user = await getLoggedUser(site.base_url, token.access_token);
    const userId = `nw_${await sha256(`${site.id}|${user}`)}`;
    const props: NexWaveAuthProps = {
      siteId: site.id,
      siteName: site.display_name,
      baseUrl: site.base_url,
      user,
      upstreamAccessToken: token.access_token,
      upstreamRefreshToken: token.refresh_token,
      upstreamExpiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
      upstreamClientId: site.client_id,
      upstreamClientSecret: clientSecret,
    };
    const scope = stored.oauthRequest.scope.filter((value) => value === LOCAL_SCOPE);
    const { redirectTo } = await context.env.OAUTH_PROVIDER.completeAuthorization({
      request: stored.oauthRequest,
      userId,
      metadata: { siteId: site.id, siteName: site.display_name, user },
      scope,
      props,
    });
    await audit(context.env, "oauth_authorized", site.id, userId);
    return new Response(null, {
      status: 302,
      headers: { Location: redirectTo, "Set-Cookie": clearCookie(context.req.raw) },
    });
  } catch (error) {
    await audit(context.env, "oauth_failed", site.id, undefined, safeError(error));
    return new Response(`NexWave sign-in failed: ${safeError(error)}`, { status: 502 });
  }
});

export async function refreshUpstreamOnTokenExchange(
  options: TokenExchangeCallbackOptions,
): Promise<TokenExchangeCallbackResult | void> {
  const props = options.props as NexWaveAuthProps | undefined;
  if (!props?.upstreamAccessToken) return;

  if (options.grantType === GrantType.REFRESH_TOKEN) {
    const refreshed = await refreshFrappeToken(props);
    return {
      newProps: refreshed,
      accessTokenTTL: upstreamTtl(refreshed),
    };
  }

  return { accessTokenTTL: upstreamTtl(props) };
}

function upstreamTtl(props: NexWaveAuthProps): number {
  return Math.max(60, Math.min(3600, Math.floor((props.upstreamExpiresAt - Date.now()) / 1000)));
}

function renderConsent(
  client: ClientInfo,
  request: AuthRequest,
  sites: Awaited<ReturnType<typeof listSites>>,
  pendingId: string,
  csrfToken: string,
): string {
  const clientName = client.clientName || "An MCP client";
  const options = sites.length
    ? sites.map((site) => `<option value="${escapeHtml(site.id)}">${escapeHtml(site.display_name)} (${escapeHtml(site.base_url)})</option>`).join("")
    : '<option value="">No NexWave sites are available</option>';
  const scopeText = request.scope.length ? request.scope.join(", ") : LOCAL_SCOPE;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect NexWave</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#172034;background:#f3f6fb}body{margin:0;display:grid;min-height:100vh;place-items:center}.card{box-sizing:border-box;width:min(500px,calc(100% - 32px));background:#fff;border:1px solid #dce3ef;border-radius:18px;padding:28px;box-shadow:0 16px 50px rgba(28,45,78,.1)}h1{margin:0 0 12px;font-size:28px}p{color:#59667d;line-height:1.55}label{display:block;font-size:13px;font-weight:750;margin:22px 0 7px}select{box-sizing:border-box;width:100%;padding:12px;border:1px solid #bdc8d9;border-radius:9px;background:#fff;font:inherit}.scope{background:#f2f6fa;border-radius:9px;padding:11px;color:#3f4c61;font-size:14px}.actions{display:flex;gap:10px;margin-top:22px}button{border:0;border-radius:9px;padding:11px 17px;font:inherit;font-weight:750;cursor:pointer}.approve{background:#087a65;color:#fff}.cancel{background:#e9eef5;color:#3f4c61}</style></head><body><main class="card"><h1>Connect to NexWave</h1><p><strong>${escapeHtml(clientName)}</strong> wants read-only access to a NexWave site through this MCP server.</p><div class="scope">Requested access: ${escapeHtml(scopeText)}</div><form method="post" action="/authorize"><input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><label for="site_id">NexWave site</label><select id="site_id" name="site_id" required ${sites.length ? "" : "disabled"}>${options}</select><div class="actions"><button class="approve" name="decision" value="approve" ${sites.length ? "" : "disabled"}>Continue to NexWave</button><button class="cancel" name="decision" value="deny">Cancel</button></div></form></main></body></html>`;
}

function authorizationErrorResponse(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) throw error;
  if (!error.redirectUri) return new Response(error.description, { status: 400 });
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 302);
}

function oauthDeniedResponse(request: AuthRequest, description = "The user cancelled the request."): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", description);
  if (request.state) redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  return Response.redirect(redirect, 302);
}

function callbackUrl(request: Request): string {
  return new URL("/oauth/frappe/callback", request.url).toString();
}

function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || !value) throw new Error(`Missing form value: ${name}`);
  return value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
