import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { authApp, refreshUpstreamOnTokenExchange } from "./auth";
import { adminApp } from "./admin";
import { mcpHandler } from "./mcp";
import { handleServiceMcpRequest, SERVICE_MCP_ROUTE } from "./service-mcp";
import type { Env } from "./types";

const apiHandler = {
  fetch(request, env, ctx) {
    return mcpHandler(request, env, ctx);
  },
} satisfies ExportedHandler<Env> & { fetch: NonNullable<ExportedHandler<Env>["fetch"]> };

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/favicon.ico" || path === "/brand/nexwave-logo.png") {
      return env.ASSETS.fetch(request);
    }

    const adminResponse = await adminApp.fetch(request, env, ctx);
    if (adminResponse.status !== 404) return adminResponse;
    return authApp.fetch(request, env, ctx);
  },
};

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: ["nexwave:read"],
  resourceMetadata: {
    scopes_supported: ["nexwave:read"],
    resource_name: "NexWave MCP",
  },
  tokenExchangeCallback: refreshUpstreamOnTokenExchange,
  accessTokenTTL: 3600,
  refreshTokenTTL: 2_592_000,
  clientRegistrationTTL: 7_776_000,
});

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === SERVICE_MCP_ROUTE) {
      return handleServiceMcpRequest(request, env, ctx);
    }
    return provider.fetch(request, env, ctx);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(provider.purgeExpiredData(env, { batchSize: 100 }));
  },
} satisfies ExportedHandler<Env>;
