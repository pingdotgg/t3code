import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import crypto from "node:crypto";
import http from "node:http";
import { AUTH_ERROR_URL, AUTH_SUCCESS_URL } from "../Auth/AuthProvider.ts";

export class OAuthError extends Data.TaggedError("OAuthError")<{
  error: string;
  errorDescription: string;
}> {}

export interface OAuthCredentials {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  scopes: string[];
}

export interface Authorization {
  url: string;
  state: string;
}

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
 * itself, not requested per-authorization. Rotate by registering a new
 * secret and cutting a release.
 */
export const OAUTH_CLIENT_ID = "pscale_app_aa12e3938baebb788aac443f66e422da";
export const OAUTH_CLIENT_SECRET =
  "pscale_app_secret_yyZ3Q8oe99GP9_yA5wrA5er6RuN6Lz9dC66Bj1OJzpg";

export const OAUTH_REDIRECT_URI = "http://localhost:9976/auth/callback";
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

function generateState(length = 32): string {
  return crypto.randomBytes(length).toString("base64url");
}

function extractCredentials(json: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}): OAuthCredentials {
  return {
    type: "oauth",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    scopes: json.scope ? json.scope.split(" ") : [],
  };
}

const tokenRequest = (
  params: Record<string, string>,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  Effect.gen(function* () {
    // PlanetScale's docs show the token endpoint with all parameters in
    // the query string (https://planetscale.com/docs/api/reference/oauth).
    // Their .well-known discovery doc advertises client_secret_basic /
    // client_secret_post instead, but both behave identically to the
    // query-string form in practice, so we follow the public docs
    // literally.
    const url = new URL(OAUTH_ENDPOINTS.token);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(url.toString(), {
          method: "POST",
          headers: { Accept: "application/json" },
        }),
      catch: (err) =>
        new OAuthError({
          error: "network_error",
          errorDescription: `Token request failed: ${err}`,
        }),
    });

    if (!res.ok) {
      const json = yield* Effect.tryPromise({
        try: () =>
          res.json() as Promise<{ error: string; error_description: string }>,
        catch: () =>
          new OAuthError({
            error: "parse_error",
            errorDescription: `Token endpoint returned ${res.status}`,
          }),
      });
      return yield* new OAuthError({
        error: json.error,
        errorDescription: json.error_description,
      });
    }

    const json = yield* Effect.tryPromise({
      try: () =>
        res.json() as Promise<{
          access_token: string;
          refresh_token: string;
          expires_in: number;
          scope: string;
        }>,
      catch: () =>
        new OAuthError({
          error: "parse_error",
          errorDescription: "Failed to parse token response",
        }),
    });
    return extractCredentials(json);
  });

/**
 * Generate a PlanetScale authorization URL.
 *
 * No `scope` parameter is sent: PlanetScale scopes are configured on the
 * OAuth application itself, not requested per-authorization, so the
 * consent screen shows whatever the app is registered with.
 */
export function authorize(): Authorization {
  const state = generateState();
  const url = new URL(OAUTH_ENDPOINTS.authorize);
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

/**
 * Exchange an authorization code for OAuth credentials.
 */
export const exchange = (
  code: string,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    redirect_uri: OAUTH_REDIRECT_URI,
  });

/**
 * Refresh expired OAuth credentials.
 */
export const refresh = (
  credentials: OAuthCredentials,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  tokenRequest({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
  });

/**
 * Start a local HTTP server to listen for the OAuth callback, exchange
 * the authorization code, and return the credentials.
 *
 * Times out after 5 minutes.
 */
export const callback = (
  authorization: Authorization,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  Effect.tryPromise({
    try: () => callbackPromise(authorization),
    catch: (err) => {
      if (err instanceof OAuthError) return err;
      return new OAuthError({
        error: "callback_error",
        errorDescription: `OAuth callback failed: ${err}`,
      });
    },
  });

function callbackPromise(
  authorization: Authorization,
): Promise<OAuthCredentials> {
  const { pathname, port } = new URL(OAUTH_REDIRECT_URI);

  return new Promise<OAuthCredentials>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname !== pathname) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }

      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      if (error) {
        res.writeHead(302, { Location: AUTH_ERROR_URL });
        res.end();
        cleanup();
        reject(
          new OAuthError({
            error,
            errorDescription: errorDescription ?? "An unknown error occurred.",
          }),
        );
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        res.writeHead(302, { Location: AUTH_ERROR_URL });
        res.end();
        cleanup();
        reject(
          new OAuthError({
            error: "invalid_request",
            errorDescription: "Missing code or state",
          }),
        );
        return;
      }

      if (state !== authorization.state) {
        res.writeHead(302, { Location: AUTH_ERROR_URL });
        res.end();
        cleanup();
        reject(
          new OAuthError({
            error: "invalid_request",
            errorDescription: "Invalid state",
          }),
        );
        return;
      }

      try {
        const credentials = await Effect.runPromise(exchange(code));
        res.writeHead(302, { Location: AUTH_SUCCESS_URL });
        res.end();
        cleanup();
        resolve(credentials);
      } catch (err) {
        res.writeHead(302, { Location: AUTH_ERROR_URL });
        res.end();
        cleanup();
        reject(err);
      }
    });

    const timeout = setTimeout(
      () => {
        cleanup();
        reject(
          new OAuthError({
            error: "timeout",
            errorDescription: "The authorization process timed out.",
          }),
        );
      },
      5 * 60 * 1000,
    );

    function cleanup() {
      clearTimeout(timeout);
      server.close();
    }

    server.on("error", (err) => {
      cleanup();
      reject(
        new OAuthError({
          error: "server_error",
          errorDescription: `Failed to start callback server: ${err.message}`,
        }),
      );
    });

    server.listen(Number(port));
  });
}
