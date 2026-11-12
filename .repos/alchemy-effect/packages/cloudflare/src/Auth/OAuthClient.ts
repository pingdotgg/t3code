import { makeOAuthClient, type OAuthCredentials } from "alchemy/Auth/OAuthFlow";

/**
 * The `cf` CLI's public Cloudflare OAuth client (no secret), shared with
 * workers-sdk's `cf` login. New authorizations use the device flow
 * (RFC 8628) against it.
 */
export const OAUTH_CLIENT_ID = "cbca97e7-c331-4cdd-8fd8-e25a451b98bf";
/**
 * Alchemy's previous Cloudflare OAuth client. Grants issued to it keep
 * refreshing; a manual `profile refresh` re-authorizes them against
 * {@link OAUTH_CLIENT_ID}.
 */
export const LEGACY_OAUTH_CLIENT_ID = "e7e25ec474419def6ba38d2d2638b122";
export const OAUTH_ENDPOINTS = {
  deviceAuthorization: "https://dash.cloudflare.com/oauth2/device/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
};

export { OAuthCredentials, OAuthError, type DeviceAuthorization } from "alchemy/Auth/OAuthFlow";

const client = makeOAuthClient({
  clientId: OAUTH_CLIENT_ID,
  endpoints: OAUTH_ENDPOINTS,
  auth: { kind: "pkce" },
});

const legacyClient = makeOAuthClient({
  clientId: LEGACY_OAUTH_CLIENT_ID,
  endpoints: { token: OAUTH_ENDPOINTS.token, revoke: OAUTH_ENDPOINTS.revoke },
  auth: { kind: "pkce" },
});

/**
 * The client that can refresh and revoke `credentials`, or `undefined` when
 * they were issued to a client Alchemy no longer knows.
 */
export const clientFor = (credentials: Pick<OAuthCredentials, "clientId">) =>
  credentials.clientId === OAUTH_CLIENT_ID
    ? client
    : credentials.clientId === LEGACY_OAUTH_CLIENT_ID
      ? legacyClient
      : undefined;

export const { deviceAuthorize, deviceToken, refresh, revoke, usesCurrentClient } = client;
