export interface AuthorizeParams {
  authorizationEndpoint: string;
  clientId: string;
  /** Space-separated scopes; empty omits the parameter. */
  scope: string;
  resource: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/**
 * Same parameter set and order as omp's MCPOAuthFlow.generateAuthUrl
 * (oh-my-pi packages/coding-agent/src/mcp/oauth-flow.ts:426-481). No `audience` is sent.
 */
export function buildAuthorizeUrl(params: AuthorizeParams): string {
  const url = new URL(params.authorizationEndpoint);
  const query = url.searchParams;
  query.set("response_type", "code");
  query.set("client_id", params.clientId);
  if (params.scope) {
    query.set("scope", params.scope);
  }
  if (params.scope.split(/\s+/).includes("offline_access")) {
    query.set("prompt", "consent");
  }
  query.set("resource", params.resource);
  query.set("redirect_uri", params.redirectUri);
  query.set("state", params.state);
  query.set("code_challenge", params.codeChallenge);
  query.set("code_challenge_method", "S256");
  return url.toString();
}
