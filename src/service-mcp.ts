import { createMcpHandler } from "agents/mcp/server";
import { getSiteByServiceTokenHash } from "./db";
import { createNexWaveServer } from "./mcp";
import { normaliseMcpToolArguments } from "./mcp-request";
import { decryptSecret, sha256 } from "./security";
import type { Env, NexWaveApiTokenAuthProps } from "./types";

export const SERVICE_MCP_ROUTE = "/service/mcp";
export const SERVICE_MCP_TOKEN_HEADER = "X-NexWave-Service-Token";

type ServiceAuthenticationResult =
  | { props: NexWaveApiTokenAuthProps }
  | { response: Response };

export async function handleServiceMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const authentication = await authenticateServiceMcpRequest(request, env);
  if ("response" in authentication) return authentication.response;

  const handler = createMcpHandler(createNexWaveServer, {
    route: SERVICE_MCP_ROUTE,
    legacy: "stateless",
    authContext: { props: { ...authentication.props } },
  });
  return handler(await normaliseMcpToolArguments(withoutServiceToken(request)), env, ctx);
}

export async function authenticateServiceMcpRequest(
  request: Request,
  env: Env,
): Promise<ServiceAuthenticationResult> {
  const suppliedToken = request.headers.get(SERVICE_MCP_TOKEN_HEADER);
  if (!suppliedToken) {
    return { response: errorResponse("A valid service token is required.", 401) };
  }

  const site = await getSiteByServiceTokenHash(env, await sha256(suppliedToken));
  if (!site) {
    return { response: errorResponse("A valid service token is required.", 401) };
  }
  if (!site.enabled) {
    return { response: errorResponse("The NexWave service connection is disabled.", 403) };
  }
  if (
    site.auth_type !== "api_token"
    || !site.encrypted_api_key
    || !site.encrypted_api_secret
    || !site.api_user
  ) {
    return { response: errorResponse("The NexWave service connection is not available.", 503) };
  }

  let apiKey: string;
  let apiSecret: string;
  try {
    [apiKey, apiSecret] = await Promise.all([
      decryptSecret(site.encrypted_api_key, env.CONFIG_ENCRYPTION_KEY),
      decryptSecret(site.encrypted_api_secret, env.CONFIG_ENCRYPTION_KEY),
    ]);
  } catch {
    return { response: errorResponse("The NexWave service connection is not available.", 503) };
  }

  return {
    props: {
      authType: "api_token",
      siteId: site.id,
      siteName: site.display_name,
      baseUrl: site.base_url,
      user: site.api_user,
      upstreamApiKey: apiKey,
      upstreamApiSecret: apiSecret,
    },
  };
}

function withoutServiceToken(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(SERVICE_MCP_TOKEN_HEADER);
  return new Request(request, { headers });
}

function errorResponse(error: string, status: number): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
