import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import crypto from "node:crypto";
import http from "node:http";
import {
  OAUTH_CLIENT_ID,
  OAUTH_ENDPOINTS,
  OAUTH_REDIRECT_URI,
} from "./AuthProvider.ts";

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
  verifier: string;
}

function generateState(length = 32): string {
  return crypto.randomBytes(length).toString("base64url");
}

function generatePKCE(length = 96): {
  verifier: string;
  challenge: string;
} {
  const verifier = crypto.randomBytes(length).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
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
    scopes: json.scope.split(" "),
  };
}

const tokenRequest = (
  body: Record<string, string>,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(OAUTH_ENDPOINTS.token, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(body).toString(),
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
 * Generate an authorization URL with PKCE for the given scopes.
 */
export function authorize(scopes: string[]): Authorization {
  const state = generateState();
  const pkce = generatePKCE();
  const url = new URL(OAUTH_ENDPOINTS.authorize);
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), state, verifier: pkce.verifier };
}

/**
 * Exchange an authorization code for OAuth credentials.
 */
export const exchange = (
  code: string,
  verifier: string,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: OAUTH_CLIENT_ID,
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
    redirect_uri: OAUTH_REDIRECT_URI,
  });

/**
 * Revoke OAuth credentials.
 */
export const revoke = (
  credentials: OAuthCredentials,
): Effect.Effect<void, OAuthError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        fetch(OAUTH_ENDPOINTS.revoke, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            refresh_token: credentials.refresh,
            client_id: OAUTH_CLIENT_ID,
            redirect_uri: OAUTH_REDIRECT_URI,
          }).toString(),
        }),
      catch: (err) =>
        new OAuthError({
          error: "network_error",
          errorDescription: `Revoke request failed: ${err}`,
        }),
    });
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
        res.writeHead(302, { Location: "https://alchemy.run/auth/error" });
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
        res.writeHead(302, { Location: "https://alchemy.run/auth/error" });
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
        res.writeHead(302, { Location: "https://alchemy.run/auth/error" });
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
        const credentials = await Effect.runPromise(
          exchange(code, authorization.verifier),
        );
        res.writeHead(302, {
          Location: "https://alchemy.run/auth/success",
        });
        res.end();
        cleanup();
        resolve(credentials);
      } catch (err) {
        res.writeHead(302, { Location: "https://alchemy.run/auth/error" });
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
