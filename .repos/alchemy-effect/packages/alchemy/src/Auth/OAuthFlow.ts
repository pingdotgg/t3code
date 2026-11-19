import http from "node:http";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Base64Url } from "effect/encoding";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Url from "effect/http/Url";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { AUTH_ERROR_URL, AUTH_SUCCESS_URL } from "./AuthProvider.ts";

/**
 * The authorization server rejected a request with an OAuth error code
 * (RFC 6749 §5.2, RFC 8628 §3.5). `error` is the server's code verbatim.
 */
export class OAuthError extends Data.TaggedError("OAuthError")<{
  error: string;
  errorDescription: string;
}> {
  override get message(): string {
    return `${this.error}: ${this.errorDescription}`;
  }
}

/** A request to the authorization server could not be sent or answered. */
export class OAuthNetworkError extends Data.TaggedError("OAuthNetworkError")<{
  endpoint: string;
  cause: unknown;
}> {
  override get message(): string {
    return `Request to ${this.endpoint} failed: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
  }
}

/**
 * The authorization server answered 429/5xx without an OAuth error body
 * (typically an edge error page). Transient.
 */
export class OAuthServerUnavailable extends Data.TaggedError("OAuthServerUnavailable")<{
  endpoint: string;
  status: number;
}> {
  override get message(): string {
    return `${this.endpoint} is temporarily unavailable (HTTP ${this.status}).`;
  }
}

/** The authorization server's response could not be interpreted. */
export class OAuthInvalidResponse extends Data.TaggedError("OAuthInvalidResponse")<{
  endpoint: string;
  status: number;
  reason: string;
}> {
  override get message(): string {
    return `Unexpected response from ${this.endpoint} (HTTP ${this.status}): ${this.reason}`;
  }
}

/** Every way a request to the authorization server can fail. */
export type OAuthRequestError =
  | OAuthError
  | OAuthNetworkError
  | OAuthServerUnavailable
  | OAuthInvalidResponse;

/** The client spec lacks the endpoints/URIs a flow needs. */
export class UnsupportedOAuthFlowError extends Data.TaggedError("UnsupportedOAuthFlowError")<{
  flow: "browser" | "device";
}> {
  override get message(): string {
    return `This OAuth client is not configured for the ${this.flow} flow.`;
  }
}

/** A callback redirect or pasted code lacks a code or carries the wrong state. */
export class OAuthCallbackError extends Data.TaggedError("OAuthCallbackError")<{
  reason: "missing_code" | "state_mismatch";
}> {
  override get message(): string {
    return this.reason === "missing_code"
      ? "The authorization code is missing."
      : "The authorization state does not match.";
  }
}

/** No browser callback arrived within 5 minutes. */
export class OAuthCallbackTimeout extends Data.TaggedError("OAuthCallbackTimeout") {
  override get message(): string {
    return "The authorization process timed out.";
  }
}

/**
 * The device authorization endpoint pointed the user at a URL outside the
 * authorization server's host (RFC 8628 §5.4, remote phishing).
 */
export class UntrustedVerificationUriError extends Data.TaggedError(
  "UntrustedVerificationUriError",
)<{
  url: string;
  expectedHost: string;
}> {
  override get message(): string {
    return `Refusing verification URL outside ${this.expectedHost}: ${this.url}`;
  }
}

/** The user denied the device authorization. */
export class DeviceAuthorizationDenied extends Data.TaggedError("DeviceAuthorizationDenied") {
  override get message(): string {
    return "The device authorization was denied.";
  }
}

/** The device code expired (or the 5 minute cap passed) before approval. */
export class DeviceAuthorizationExpired extends Data.TaggedError("DeviceAuthorizationExpired") {
  override get message(): string {
    return "The device authorization expired before it was approved.";
  }
}

/**
 * The local loopback callback server could not start (typically the port is
 * already taken). Distinct from {@link CallbackServerError} so callers can
 * fall back to manual code entry instead of failing the whole flow.
 */
export class CallbackServerStartError extends Data.TaggedError("CallbackServerStartError")<{
  message: string;
}> {}

/** The loopback callback server failed after it started listening. */
export class CallbackServerError extends Data.TaggedError("CallbackServerError")<{
  message: string;
}> {}

/**
 * On-disk shape of OAuth credentials persisted under
 * `~/.alchemy/credentials/{profile}/<provider>-oauth.json`.
 *
 * `clientId` is optional because files written before the client id was
 * recorded must still parse — {@link OAuthClient.usesCurrentClient} treats a
 * missing id as "issued to a previous client", which triggers a clean
 * re-login.
 */
export const OAuthCredentials = Schema.Struct({
  type: Schema.Literal("oauth"),
  clientId: Schema.optional(Schema.String),
  access: Schema.RedactedFromValue(Schema.String),
  refresh: Schema.RedactedFromValue(Schema.String),
  expires: Schema.Number,
  scopes: Schema.String.pipe(Schema.Array, Schema.mutable),
});
export type OAuthCredentials = typeof OAuthCredentials.Type;

/**
 * A pending OAuth 2.0 Device Authorization Grant (RFC 8628): the user
 * approves `userCode` at `verificationUri` while the CLI polls for tokens.
 */
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Verification URL with the user code pre-filled. */
  verificationUriComplete: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Seconds between token polls. */
  interval: number;
}

export interface Authorization {
  url: string;
  state: string;
  /** PKCE verifier; present only for `auth: { kind: "pkce" }` clients. */
  verifier?: string;
}

/**
 * The provider-specific facts an OAuth flow needs. Everything else —
 * state/PKCE generation, the loopback callback server, hosted-relay code
 * extraction, device-code polling, token exchange, refresh, revoke — is
 * shared.
 *
 * The browser (authorization-code) flow needs `endpoints.authorize`,
 * `redirectUri` and `localCallbackUri`; the device flow needs
 * `endpoints.deviceAuthorization`. A client that only refreshes and revokes
 * existing grants needs neither.
 */
export interface OAuthClientSpec {
  readonly clientId: string;
  readonly endpoints: {
    readonly authorize?: string;
    /** RFC 8628 device authorization endpoint. */
    readonly deviceAuthorization?: string;
    readonly token: string;
    /** Providers without a revocation endpoint omit it; `revoke` then no-ops. */
    readonly revoke?: string;
  };
  /** Hosted relay redirect URI registered with the OAuth application. */
  readonly redirectUri?: string;
  /** Loopback URI the local callback server listens on. */
  readonly localCallbackUri?: string;
  /**
   * Client authentication. `pkce` for public clients; `clientSecret` for
   * providers whose token endpoint requires client authentication for every
   * grant (the secret ships in the CLI — same exposure posture as a public
   * client id, rotated by cutting a release).
   */
  readonly auth:
    | { readonly kind: "pkce" }
    | { readonly kind: "clientSecret"; readonly clientSecret: Redacted.Redacted<string> };
  /**
   * How token-request parameters travel: URL-encoded POST body (the OAuth 2
   * standard, default) or the query string (PlanetScale's documented form).
   */
  readonly tokenTransport?: "body" | "query";
}

export interface OAuthClient {
  readonly clientId: string;
  /** Whether persisted credentials were issued to this client. */
  readonly usesCurrentClient: (credentials: { readonly clientId?: unknown }) => boolean;
  /**
   * Generate an authorization URL. Pass `scopes` only for providers that
   * take them per-authorization; omit for providers whose scopes are
   * configured on the application.
   */
  readonly authorize: (
    scopes?: ReadonlyArray<string>,
  ) => Effect.Effect<
    Authorization,
    UnsupportedOAuthFlowError,
    SecureRandom.SecureRandom | Digest.Digest
  >;
  /**
   * Exchange an authorization code directly. `authorization` supplies the
   * PKCE verifier; omit for non-PKCE clients (tests, relay-less flows).
   */
  readonly exchange: (
    code: string,
    authorization?: Authorization,
  ) => Effect.Effect<OAuthCredentials, OAuthRequestError | UnsupportedOAuthFlowError, never>;
  /**
   * Exchange a code copied from the hosted relay page, or extract the code
   * from either the hosted or loopback callback URL.
   */
  readonly exchangeCallbackInput: (
    input: string,
    authorization: Authorization,
  ) => Effect.Effect<
    OAuthCredentials,
    OAuthRequestError | OAuthCallbackError | UnsupportedOAuthFlowError,
    never
  >;
  /**
   * Start a local HTTP server to listen for the OAuth callback, exchange
   * the authorization code, and return the credentials. Times out after 5
   * minutes.
   */
  readonly callback: (
    authorization: Authorization,
  ) => Effect.Effect<
    OAuthCredentials,
    | OAuthRequestError
    | OAuthCallbackError
    | OAuthCallbackTimeout
    | CallbackServerStartError
    | CallbackServerError
    | UnsupportedOAuthFlowError,
    never
  >;
  /** Start an RFC 8628 device authorization for `scopes`. */
  readonly deviceAuthorize: (
    scopes?: ReadonlyArray<string>,
  ) => Effect.Effect<
    DeviceAuthorization,
    OAuthRequestError | UnsupportedOAuthFlowError | UntrustedVerificationUriError,
    never
  >;
  /**
   * Poll the token endpoint until the user approves (or denies) the device
   * authorization. Times out when the device code expires, capped at 5
   * minutes.
   */
  readonly deviceToken: (
    authorization: DeviceAuthorization,
  ) => Effect.Effect<
    OAuthCredentials,
    OAuthRequestError | DeviceAuthorizationDenied | DeviceAuthorizationExpired,
    never
  >;
  /** Refresh expired OAuth credentials with the stored refresh token. */
  readonly refresh: (
    credentials: OAuthCredentials,
  ) => Effect.Effect<OAuthCredentials, OAuthRequestError, never>;
  /** Revoke the refresh token; no-op when the spec has no revoke endpoint. */
  readonly revoke: (credentials: OAuthCredentials) => Effect.Effect<void, OAuthNetworkError>;
}

const randomText = Effect.fn(function* (length: number) {
  const random = yield* SecureRandom.SecureRandom;
  return Base64Url.encode(yield* random.randomBytes(length));
});

const generatePKCE = Effect.fn(function* (length = 96) {
  const digest = yield* Digest.Digest;
  const verifier = yield* randomText(length);
  const challenge = yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier));
  return { verifier, challenge: Base64Url.encode(challenge) };
});

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  scope: Schema.optional(Schema.String),
});

const DeviceAuthorizationResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Number),
});

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const TokenErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});

export const makeOAuthClient = (spec: OAuthClientSpec): OAuthClient => {
  const provideHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(Effect.provide(FetchHttpClient.layer));
  const clientAuthParams = (): Record<string, string> =>
    spec.auth.kind === "clientSecret"
      ? { client_secret: Redacted.value(spec.auth.clientSecret) }
      : {};

  /**
   * POST form params to an authorization-server endpoint and decode the 2xx
   * body with `success`. Non-2xx responses surface the server's OAuth error
   * code as {@link OAuthError}.
   */
  const postForm = Effect.fn(function* <A>(
    endpoint: string,
    params: Record<string, string>,
    success: Schema.ConstraintDecoder<A, never>,
    transport: "body" | "query" = "body",
  ) {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeader("Accept", "application/json"),
      transport === "query"
        ? HttpClientRequest.setUrlParams(params)
        : HttpClientRequest.bodyUrlParams(params),
    );
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError((cause) => new OAuthNetworkError({ endpoint, cause })));
    const { status } = response;
    if (status < 200 || status >= 300) {
      const json = yield* HttpClientResponse.schemaBodyJson(TokenErrorResponse)(response).pipe(
        Effect.mapError(() =>
          status === 429 || status >= 500
            ? new OAuthServerUnavailable({ endpoint, status })
            : new OAuthInvalidResponse({ endpoint, status, reason: "no OAuth error body" }),
        ),
      );
      return yield* new OAuthError({
        error: json.error,
        errorDescription: json.error_description ?? `HTTP ${status}`,
      });
    }
    return yield* HttpClientResponse.schemaBodyJson(success)(response).pipe(
      Effect.mapError(
        () => new OAuthInvalidResponse({ endpoint, status, reason: "unexpected response body" }),
      ),
    );
  });

  const tokenRequest = Effect.fn(function* (
    params: Record<string, string>,
    previous?: OAuthCredentials,
  ) {
    const endpoint = spec.endpoints.token;
    const json = yield* postForm(endpoint, params, TokenResponse, spec.tokenTransport);
    const refresh =
      json.refresh_token === undefined ? previous?.refresh : Redacted.make(json.refresh_token);
    if (!refresh) {
      return yield* new OAuthInvalidResponse({
        endpoint,
        status: 200,
        reason: "no refresh token was returned for this authorization",
      });
    }
    const now = yield* Clock.currentTimeMillis;
    return {
      type: "oauth" as const,
      clientId: spec.clientId,
      access: Redacted.make(json.access_token),
      refresh,
      expires: now + json.expires_in * 1000,
      scopes: json.scope?.split(" ") ?? previous?.scopes ?? [],
    } satisfies OAuthCredentials;
  });

  const browserSpec = Effect.suspend(() => {
    const { redirectUri, localCallbackUri } = spec;
    const authorizeEndpoint = spec.endpoints.authorize;
    return redirectUri === undefined ||
      localCallbackUri === undefined ||
      authorizeEndpoint === undefined
      ? Effect.fail(new UnsupportedOAuthFlowError({ flow: "browser" }))
      : Effect.succeed({ redirectUri, localCallbackUri, authorizeEndpoint });
  });

  const authorize = Effect.fn(function* (scopes?: ReadonlyArray<string>) {
    const { authorizeEndpoint, redirectUri } = yield* browserSpec;
    const state = yield* randomText(32);
    const url = new URL(authorizeEndpoint);
    url.searchParams.set("client_id", spec.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    if (scopes !== undefined) {
      url.searchParams.set("scope", scopes.join(" "));
    }
    url.searchParams.set("state", state);
    if (spec.auth.kind === "pkce") {
      const pkce = yield* generatePKCE();
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return { url: url.toString(), state, verifier: pkce.verifier };
    }
    return { url: url.toString(), state };
  });

  const exchange = Effect.fn(function* (code: string, authorization?: Authorization) {
    const { redirectUri } = yield* browserSpec;
    return yield* tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: spec.clientId,
      redirect_uri: redirectUri,
      ...clientAuthParams(),
      ...(authorization?.verifier === undefined ? {} : { code_verifier: authorization.verifier }),
    });
  });

  const deviceAuthorize = Effect.fn(function* (scopes?: ReadonlyArray<string>) {
    const endpoint = spec.endpoints.deviceAuthorization;
    if (endpoint === undefined) return yield* new UnsupportedOAuthFlowError({ flow: "device" });
    const json = yield* postForm(
      endpoint,
      {
        client_id: spec.clientId,
        ...(scopes === undefined ? {} : { scope: scopes.join(" ") }),
        ...clientAuthParams(),
      },
      DeviceAuthorizationResponse,
    );
    // The server picks where the user is sent to type their code; only
    // trust https URLs on the authorization server's own host (RFC 8628
    // §5.4, remote phishing).
    const expectedHost = new URL(endpoint).host;
    const trustedUrl = (value: string) => {
      const untrusted = () => new UntrustedVerificationUriError({ url: value, expectedHost });
      return Url.fromString(value).pipe(
        Result.mapError(untrusted),
        Result.filterOrFail(
          (url) =>
            url.protocol === "https:" &&
            url.username === "" &&
            url.password === "" &&
            url.host === expectedHost,
          untrusted,
        ),
        Effect.fromResult,
      );
    };
    const verificationUri = yield* trustedUrl(json.verification_uri);
    const complete =
      json.verification_uri_complete === undefined
        ? Url.mutate(verificationUri, (url) => url.searchParams.set("user_code", json.user_code))
        : yield* trustedUrl(json.verification_uri_complete);
    return {
      deviceCode: json.device_code,
      userCode: json.user_code,
      verificationUri: json.verification_uri,
      verificationUriComplete: complete.toString(),
      expiresIn: json.expires_in,
      interval: json.interval ?? 5,
    } satisfies DeviceAuthorization;
  });

  const deviceToken = Effect.fn(function* (authorization: DeviceAuthorization) {
    let interval = Math.max(authorization.interval, 1);
    // The delay is read on every recurrence, so slow_down's bump applies to
    // all later polls.
    const schedule = Schedule.forever.pipe(
      Schedule.modifyDelay(() => Effect.sync(() => Duration.seconds(interval))),
    );
    return yield* tokenRequest({
      grant_type: DEVICE_CODE_GRANT,
      device_code: authorization.deviceCode,
      client_id: spec.clientId,
      ...clientAuthParams(),
    }).pipe(
      Effect.tapError((e) =>
        Effect.sync(() => {
          // RFC 8628 §3.5: slow_down adds 5 seconds to every later poll.
          if (e._tag === "OAuthError" && e.error === "slow_down") interval += 5;
        }),
      ),
      Effect.retry({
        schedule,
        // Transient failures, or RFC 8628 §3.5 codes meaning the user has
        // not decided yet.
        while: (e) =>
          ["OAuthNetworkError", "OAuthServerUnavailable"].includes(e._tag) ||
          (e._tag === "OAuthError" &&
            ["authorization_pending", "slow_down", "temporarily_unavailable"].includes(e.error)),
      }),
      Effect.catchTag("OAuthError", (e) =>
        Effect.fail(
          Match.value(e.error).pipe(
            Match.when("access_denied", () => new DeviceAuthorizationDenied()),
            Match.when("expired_token", () => new DeviceAuthorizationExpired()),
            Match.orElse(() => e),
          ),
        ),
      ),
      Effect.timeoutOrElse({
        duration: Duration.seconds(Math.min(authorization.expiresIn, 300)),
        orElse: () => Effect.fail(new DeviceAuthorizationExpired()),
      }),
    );
  });

  const refresh = Effect.fn(function (credentials: OAuthCredentials) {
    return tokenRequest(
      {
        grant_type: "refresh_token",
        refresh_token: Redacted.value(credentials.refresh),
        client_id: spec.clientId,
        ...clientAuthParams(),
      },
      credentials,
    );
  });

  const revoke = Effect.fn(function* (credentials: OAuthCredentials) {
    const endpoint = spec.endpoints.revoke;
    if (endpoint === undefined) return;
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.bodyUrlParams({
        token: Redacted.value(credentials.refresh),
        token_type_hint: "refresh_token",
        client_id: spec.clientId,
        ...clientAuthParams(),
      }),
    );
    yield* client.execute(request).pipe(
      Effect.mapError((cause) => new OAuthNetworkError({ endpoint, cause })),
      Effect.asVoid,
    );
  });

  const exchangeCallbackInput = Effect.fn(function* (input: string, authorization: Authorization) {
    const value = input.trim();
    // A full callback URL carries code + state; a code copied from the hosted
    // relay page is `code#state`.
    const { code, state } = Url.fromString(value).pipe(
      Result.map((url) => ({
        code: url.searchParams.get("code") ?? "",
        state: url.searchParams.get("state"),
      })),
      Result.getOrElse(() => {
        const separator = value.lastIndexOf("#");
        return separator >= 0
          ? { code: value.slice(0, separator), state: value.slice(separator + 1) }
          : { code: value, state: null };
      }),
    );

    if (!code) {
      return yield* new OAuthCallbackError({ reason: "missing_code" });
    }
    if (state !== null && state !== authorization.state) {
      return yield* new OAuthCallbackError({ reason: "state_mismatch" });
    }
    return yield* exchange(code, authorization);
  });

  type CallbackFailure =
    | OAuthRequestError
    | OAuthCallbackError
    | CallbackServerStartError
    | CallbackServerError
    | UnsupportedOAuthFlowError;

  const callback = Effect.fn(function* (authorization: Authorization) {
    const { localCallbackUri, redirectUri } = yield* browserSpec;
    const { pathname, port, protocol } = new URL(localCallbackUri);
    const listenPort = port === "" ? (protocol === "https:" ? 443 : 80) : Number(port);
    const listen = Effect.callback<OAuthCredentials, CallbackFailure, HttpClient.HttpClient>(
      (resume) => {
        // The handler can run more than once (browser retries, extra tabs);
        // resume exactly once and ignore everything after.
        let settled = false;
        const resolveOnce = (
          effect: Effect.Effect<OAuthCredentials, CallbackFailure, HttpClient.HttpClient>,
        ) => {
          if (settled) return;
          settled = true;
          resume(effect);
        };
        const server = http.createServer((req, res) => {
          const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

          if (url.pathname === "/auth/ping") {
            res.writeHead(req.method === "OPTIONS" ? 204 : 200, {
              "Access-Control-Allow-Origin": new URL(redirectUri).origin,
              "Access-Control-Allow-Methods": "GET, OPTIONS",
              "Access-Control-Allow-Private-Network": "true",
              "Cache-Control": "no-store",
            });
            res.end();
            return;
          }

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
            new OAuthError({
              error,
              errorDescription: errorDescription ?? "An unknown error occurred.",
            }).pipe(Effect.fail, resolveOnce);
            return;
          }

          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          if (!code || !state) {
            res.writeHead(302, { Location: AUTH_ERROR_URL });
            res.end();
            new OAuthCallbackError({ reason: "missing_code" }).pipe(Effect.fail, resolveOnce);
            return;
          }

          if (state !== authorization.state) {
            res.writeHead(302, { Location: AUTH_ERROR_URL });
            res.end();
            new OAuthCallbackError({ reason: "state_mismatch" }).pipe(Effect.fail, resolveOnce);
            return;
          }
          resolveOnce(
            exchange(code, authorization).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  res.writeHead(302, { Location: AUTH_SUCCESS_URL });
                  res.end();
                }),
              ),
              Effect.tapError(() =>
                Effect.sync(() => {
                  res.writeHead(302, { Location: AUTH_ERROR_URL });
                  res.end();
                }),
              ),
            ),
          );
        });

        server.on("error", (err) => {
          (server.listening
            ? new CallbackServerError({ message: `Callback server failed: ${err.message}` })
            : new CallbackServerStartError({
                message: `Failed to start callback server: ${err.message}`,
              })
          ).pipe(Effect.fail, resolveOnce);
        });

        server.listen(listenPort, "127.0.0.1");
        return Effect.sync(() => {
          server.close();
          // `close` only stops new connections — a keep-alive browser
          // connection would otherwise hold the process open until its
          // socket timeout after login completes.
          server.closeAllConnections();
        });
      },
    );
    return yield* listen.pipe(
      Effect.timeoutOrElse({
        duration: "5 minutes",
        orElse: () => Effect.fail(new OAuthCallbackTimeout()),
      }),
    );
  });

  return {
    clientId: spec.clientId,
    usesCurrentClient: (credentials) => credentials.clientId === spec.clientId,
    authorize,
    exchange: (...args) => provideHttp(exchange(...args)),
    exchangeCallbackInput: (...args) => provideHttp(exchangeCallbackInput(...args)),
    callback: (authorization) => provideHttp(callback(authorization)),
    deviceAuthorize: (scopes) => provideHttp(deviceAuthorize(scopes)),
    deviceToken: (authorization) => provideHttp(deviceToken(authorization)),
    refresh: (credentials) => provideHttp(refresh(credentials)),
    revoke: (credentials) => provideHttp(revoke(credentials)),
  };
};
