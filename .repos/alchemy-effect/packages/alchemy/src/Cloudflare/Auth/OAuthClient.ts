import { makeOAuthClient } from "../../Auth/OAuthFlow.ts";

/**
 * Alchemy's public Cloudflare OAuth client registration. The client is
 * public (PKCE, no secret); rotating it invalidates previously stored
 * credentials, which {@link usesCurrentClient} detects for a clean
 * re-login.
 */
export const OAUTH_CLIENT_ID = "e7e25ec474419def6ba38d2d2638b122";
export const OAUTH_REDIRECT_URI = "https://alchemy.run/auth/callback";
export const OAUTH_LOCAL_CALLBACK_URI = "http://localhost:9976/auth/callback";
export const OAUTH_ENDPOINTS = {
  authorize: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
};

export {
  OAuthCredentials,
  OAuthError,
  type Authorization,
} from "../../Auth/OAuthFlow.ts";

/**
 * Cloudflare's browser OAuth client: a public client using PKCE, with
 * per-authorization scopes and a revocation endpoint. All flow mechanics
 * live in the shared {@link makeOAuthClient} kit — this module only
 * supplies Cloudflare's registration facts.
 */
const client = makeOAuthClient({
  clientId: OAUTH_CLIENT_ID,
  endpoints: OAUTH_ENDPOINTS,
  redirectUri: OAUTH_REDIRECT_URI,
  localCallbackUri: OAUTH_LOCAL_CALLBACK_URI,
  auth: { kind: "pkce" },
});

export const {
  authorize,
  callback,
  exchange,
  exchangeCallbackInput,
  refresh,
  revoke,
  usesCurrentClient,
} = client;
