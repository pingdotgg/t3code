import { makeOAuthClient } from "../Auth/OAuthFlow.ts";
import * as Redacted from "effect/Redacted";

export {
  OAuthCredentials,
  OAuthError,
  type Authorization,
} from "../Auth/OAuthFlow.ts";

/**
 * Registered PlanetScale OAuth application credentials.
 *
 * Unlike Cloudflare, PlanetScale OAuth has **no public-client flow** — the
 * token endpoint requires client authentication for every grant (PKCE is
 * advertised in their discovery doc but does not lift that requirement), so
 * exchanging the authorization code (and refreshing the token) requires the
 * application's `client_secret`. There is no way to keep that secret out of
 * a distributed CLI, so it ships here: the exposure is the same posture as a
 * public `client_id` (a stolen refresh token is usable, exactly like
 * Cloudflare's secret-less refresh), and it can be rotated by cutting a new
 * release. PlanetScale's own CLI ships its OAuth `client_secret` in source
 * the same way:
 * https://github.com/planetscale/cli/blob/main/internal/auth/authenticator.go
 *
 * Registered at https://app.planetscale.com with redirect URI
 * {@link OAUTH_REDIRECT_URI}. Scopes are configured on the application
 * itself, not requested per-authorization (so `authorize()` is called with
 * no scopes). Rotate by registering a new secret and cutting a release.
 */
export const OAUTH_CLIENT_ID = "pscale_app_aa12e3938baebb788aac443f66e422da";
export const OAUTH_CLIENT_SECRET = Redacted.make(
  "pscale_app_secret_yyZ3Q8oe99GP9_yA5wrA5er6RuN6Lz9dC66Bj1OJzpg",
);

export const OAUTH_REDIRECT_URI = "https://alchemy.run/auth/callback";
export const OAUTH_LOCAL_CALLBACK_URI = "http://localhost:9976/auth/callback";
export const OAUTH_ENDPOINTS = {
  // PlanetScale's own .well-known OAuth discovery doc declares this as
  // the authorization_endpoint — NOT auth.planetscale.com/oauth/authorize
  // (which their public docs cite). The auth.planetscale.com alias does
  // render a consent screen but emits codes whose resulting tokens lack
  // a `sub` claim, so the resource API at api.planetscale.com rejects
  // them as invalid. Use the canonical endpoint.
  authorize: "https://app.planetscale.com/oauth/authorize",
  token: "https://auth.planetscale.com/oauth/token",
};

const client = makeOAuthClient({
  clientId: OAUTH_CLIENT_ID,
  endpoints: OAUTH_ENDPOINTS,
  redirectUri: OAUTH_REDIRECT_URI,
  localCallbackUri: OAUTH_LOCAL_CALLBACK_URI,
  auth: { kind: "clientSecret", clientSecret: OAUTH_CLIENT_SECRET },
  // PlanetScale's docs show the token endpoint with all parameters in the
  // query string (https://planetscale.com/docs/api/reference/oauth). Their
  // .well-known discovery doc advertises client_secret_basic /
  // client_secret_post instead, but both behave identically to the
  // query-string form in practice, so we follow the public docs literally.
  tokenTransport: "query",
});

export const {
  authorize,
  callback,
  exchange,
  exchangeCallbackInput,
  refresh,
  usesCurrentClient,
} = client;
