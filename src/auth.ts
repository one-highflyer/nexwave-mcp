import {
  AuthorizationError,
  GrantType,
  type AuthRequest,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { renderConsent, renderErrorPage } from "./consent";
import { audit, getSite, getSiteByBaseUrl } from "./db";
import { exchangeFrappeCode, getLoggedUser, refreshFrappeToken } from "./frappe";
import {
  clearCookie,
  cookieName,
  decryptSecret,
  getCookie,
  makeCookie,
  pkceChallenge,
  randomToken,
  siteOriginFromInput,
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

  const client = await context.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) {
    return htmlResponse(
      renderErrorPage("Unknown MCP client", "This client is not registered with the NexWave MCP gateway."),
      400,
    );
  }

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

  const scriptNonce = randomToken();
  return htmlResponse(renderConsent(client, oauthRequest, pendingId, csrfToken, { scriptNonce }), 200, scriptNonce);
});

authApp.post("/authorize", async (context) => {
  const form = await context.req.formData();
  const pendingId = formValue(form, "pending_id");
  const csrfToken = formValue(form, "csrf_token");
  const stored = await context.env.OAUTH_KV.get<PendingAuthorization>(`nexwave:pending:${pendingId}`, "json");
  if (!stored || (await sha256(csrfToken)) !== stored.csrfTokenHash) {
    return htmlResponse(
      renderErrorPage("Connection request expired", "The approval request is no longer valid."),
      400,
    );
  }

  if (form.get("decision") !== "approve") {
    await context.env.OAUTH_KV.delete(`nexwave:pending:${pendingId}`);
    return oauthDeniedResponse(stored.oauthRequest);
  }

  const submittedSiteUrl = form.get("site_url");
  const siteUrl = typeof submittedSiteUrl === "string" ? submittedSiteUrl : "";
  const site = await findRequestedSite(context.env, siteUrl);
  if (!site || !site.enabled) {
    const client = await context.env.OAUTH_PROVIDER.lookupClient(stored.oauthRequest.clientId);
    if (!client) {
      return htmlResponse(renderErrorPage("Unknown MCP client", "This client is no longer registered."), 400);
    }
    const scriptNonce = randomToken();
    return htmlResponse(
      renderConsent(client, stored.oauthRequest, pendingId, csrfToken, {
        scriptNonce,
        siteUrl,
        error: "Check the site URL, or ask your administrator to add this site to the gateway.",
      }),
      400,
      scriptNonce,
    );
  }
  await context.env.OAUTH_KV.delete(`nexwave:pending:${pendingId}`);

  const state = randomToken();
  const browserToken = randomToken();
  const codeVerifier = randomToken(64);
  const upstream: PendingFrappeAuthorization = {
    oauthRequest: stored.oauthRequest,
    siteId: site.id,
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
  if (!stored) {
    return htmlResponse(
      renderErrorPage("Sign-in request expired", "The NexWave sign-in request is no longer valid."),
      400,
    );
  }

  const browserToken = getCookie(context.req.raw, cookieName(context.req.raw));
  if (!browserToken || (await sha256(browserToken)) !== stored.browserTokenHash) {
    return htmlResponse(
      renderErrorPage("Browser session changed", "Complete the connection in the same browser where you started it."),
      400,
    );
  }
  await context.env.OAUTH_KV.delete(`nexwave:frappe:${state}`);

  if (upstreamError || !code) {
    return oauthDeniedResponse(stored.oauthRequest, upstreamError ?? "access_denied");
  }

  const site = await getSite(context.env, stored.siteId);
  if (!site || !site.enabled) {
    return oauthErrorResponse(
      stored.oauthRequest,
      "temporarily_unavailable",
      "The selected NexWave site is not available.",
    );
  }

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
    return oauthErrorResponse(
      stored.oauthRequest,
      "server_error",
      "NexWave sign-in could not be completed. Please try again.",
    );
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

async function findRequestedSite(env: Env, value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return await getSiteByBaseUrl(env, siteOriginFromInput(value));
  } catch {
    return null;
  }
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
  return oauthErrorResponse(request, "access_denied", description);
}

function oauthErrorResponse(request: AuthRequest, code: string, description: string): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", code);
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

function htmlResponse(body: string, status = 200, scriptNonce?: string): Response {
  const scriptPolicy = scriptNonce ? `; script-src 'nonce-${scriptNonce}'` : "";
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'${scriptPolicy}`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
