// @effect-diagnostics nodeBuiltinImport:off - The CLI loopback OAuth callback is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Terminal from "effect/Terminal";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { buildConnectAuthorizeRequestUrl } from "@t3tools/shared/connectAuth";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import {
  cloudCliOAuthConfig,
  hostedAppUrlConfig,
  type CloudCliOAuthConfig,
} from "./publicConfig.ts";
import { renderLoopbackAuthorizationCompleteHtml } from "./cliAuthHtml.ts";

const CLOUD_CLI_OAUTH_TOKEN_SECRET = "cloud-cli-oauth-token";
const CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT = Duration.minutes(10);
const CLOUD_CLI_OAUTH_REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(5));
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
// RFC 8628 defaults, used only when Clerk omits the field.
const DEVICE_AUTHORIZATION_DEFAULT_INTERVAL = Duration.seconds(5);
// RFC 8628 §3.5: a slow_down response means "add 5 seconds to the interval".
const DEVICE_AUTHORIZATION_SLOW_DOWN_INCREMENT = Duration.seconds(5);
// A stalled OAuth request holds the semaphore and blocks all credential calls.
const OAUTH_REQUEST_TIMEOUT = Duration.seconds(10);
const boldTerminalText = (value: string): string => `\u001b[1m${value}\u001b[22m`;

function formatLoopbackAuthorizationPrompt(authorizationUrl: string): string {
  return [
    "Open this URL to authorize T3 Connect:",
    `  ${authorizationUrl}`,
    "",
    `Press ${boldTerminalText("Enter")} to open it in your browser.`,
    `No browser on this device? Press ${boldTerminalText("H")} to switch to headless mode.`,
  ].join("\n");
}

export type LoopbackAuthorizationResult =
  | { readonly _tag: "AuthorizationCode"; readonly code: string }
  | { readonly _tag: "HeadlessRequested" };

const readLoopbackAuthorizationAction = Effect.fn(
  "cloud.cli_token.read_loopback_authorization_action",
)(function* (input: Queue.Dequeue<Terminal.UserInput, Cause.Done>) {
  while (true) {
    const event = yield* Queue.take(input).pipe(Effect.mapError(() => new Terminal.QuitError({})));
    const keyName = event.key.name.toLowerCase();
    if (!event.key.ctrl && !event.key.meta && keyName === "h") {
      return "headless" as const;
    }
    if (keyName === "enter" || keyName === "return") {
      return "open-browser" as const;
    }
  }
});

const waitForLoopbackAuthorization = Effect.fn("cloud.cli_token.wait_for_loopback_authorization")(
  function* <E, R>(input: {
    readonly authorizationUrl: string;
    readonly callback: Effect.Effect<string, E, R>;
    readonly terminal: Terminal.Terminal;
    readonly launchBrowser: (
      url: string,
    ) => Effect.Effect<void, ExternalLauncher.ExternalLauncherError>;
  }) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const terminalInput = yield* input.terminal.readInput;
        while (true) {
          const result = yield* Effect.raceFirst(
            input.callback.pipe(
              Effect.map((code): LoopbackAuthorizationResult => ({
                _tag: "AuthorizationCode",
                code,
              })),
            ),
            readLoopbackAuthorizationAction(terminalInput),
          );
          if (typeof result !== "string") {
            return result;
          }
          if (result === "headless") {
            return { _tag: "HeadlessRequested" } as const;
          }
          yield* input
            .launchBrowser(input.authorizationUrl)
            .pipe(
              Effect.catch(() =>
                Console.warn(
                  `Could not open a browser on this device. Open the URL above manually, or press ${boldTerminalText("H")} to switch to headless mode.`,
                ),
              ),
            );
        }
      }),
    );
  },
);

const PersistedToken = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
  identity: Schema.optional(Schema.String),
});
export type PersistedToken = typeof PersistedToken.Type;

const PersistedTokenJson = Schema.fromJsonString(PersistedToken);
const decodePersistedToken = Schema.decodeUnknownEffect(PersistedTokenJson);
const encodePersistedToken = Schema.encodeEffect(PersistedTokenJson);

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  token_type: Schema.String,
});

const OAuthErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});
const OAuthRefreshErrorCode = Schema.Literals([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_request",
  "invalid_scope",
  "access_denied",
]);
const decodeOAuthRefreshErrorResponse = Schema.decodeUnknownOption(
  Schema.Struct({ error: OAuthRefreshErrorCode }),
);

const isPermanentRefreshStatus = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

const DeviceAuthorizationResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Number),
});

const OidcIdentityClaimsJson = Schema.fromJsonString(
  Schema.Struct({
    email: Schema.optional(Schema.String),
    preferred_username: Schema.optional(Schema.String),
    sub: Schema.optional(Schema.String),
  }),
);
const decodeOidcIdentityClaimsJson = Schema.decodeUnknownOption(OidcIdentityClaimsJson);

function idTokenIdentity(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  const decoded = Base64Url.decodeString(payload);
  if (decoded._tag !== "Success") return null;
  const claims = decodeOidcIdentityClaimsJson(decoded.success);
  if (Option.isNone(claims)) return null;
  for (const value of [claims.value.email, claims.value.preferred_username, claims.value.sub]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export class CloudCliCredentialRemovalError extends Schema.TaggedError<CloudCliCredentialRemovalError>()(
  "CloudCliCredentialRemovalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not remove the stored T3 Connect CLI credential.";
  }
}

export class CloudCliCredentialRefreshError extends Schema.TaggedError<CloudCliCredentialRefreshError>()(
  "CloudCliCredentialRefreshError",
  {
    cause: Schema.Defect(),
    status: Schema.optional(Schema.Number),
    oauthErrorCode: Schema.optional(OAuthRefreshErrorCode),
  },
) {
  get requiresLogin(): boolean {
    return this.status !== undefined && isPermanentRefreshStatus(this.status);
  }

  override get message(): string {
    return this.requiresLogin
      ? `Could not refresh the T3 Connect CLI credential${
          this.oauthErrorCode === undefined ? "" : ` (OAuth error: ${this.oauthErrorCode})`
        }. Run \`t3 connect login\` to authorize again.`
      : "Could not refresh the T3 Connect CLI credential.";
  }
}

export const isCloudCliCredentialRefreshError = Schema.is(CloudCliCredentialRefreshError);

export class CloudCliCredentialReadError extends Schema.TaggedError<CloudCliCredentialReadError>()(
  "CloudCliCredentialReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the stored T3 Connect CLI credential.";
  }
}

export class CloudCliAuthorizationError extends Schema.TaggedError<CloudCliAuthorizationError>()(
  "CloudCliAuthorizationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not authorize the T3 Connect CLI.";
  }
}

export class CloudCliAuthorizationTimeoutError extends Schema.TaggedError<CloudCliAuthorizationTimeoutError>()(
  "CloudCliAuthorizationTimeoutError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Timed out waiting for T3 Connect authorization.";
  }
}

export class CloudCliAuthorizationDeniedError extends Schema.TaggedError<CloudCliAuthorizationDeniedError>()(
  "CloudCliAuthorizationDeniedError",
  {},
) {
  override get message(): string {
    return "T3 Connect authorization was denied in the browser.";
  }
}

export const CloudCliTokenManagerError = Schema.Union([
  CloudCliCredentialRemovalError,
  CloudCliCredentialRefreshError,
  CloudCliCredentialReadError,
  CloudCliAuthorizationError,
  CloudCliAuthorizationTimeoutError,
  CloudCliAuthorizationDeniedError,
]);
export type CloudCliTokenManagerError = typeof CloudCliTokenManagerError.Type;

export class CloudCliTokenManager extends Context.Service<
  CloudCliTokenManager,
  {
    readonly get: Effect.Effect<
      | { readonly _tag: "Authorized"; readonly token: PersistedToken }
      | { readonly _tag: "HeadlessRequested" },
      CloudCliTokenManagerError | Terminal.QuitError
    >;
    readonly getExisting: Effect.Effect<Option.Option<PersistedToken>, CloudCliTokenManagerError>;
    readonly hasCredential: Effect.Effect<boolean, CloudCliTokenManagerError>;
    readonly store: (token: PersistedToken) => Effect.Effect<void, CloudCliTokenManagerError>;
    readonly clear: Effect.Effect<void, CloudCliTokenManagerError>;
  }
>()("t3/cloud/CliTokenManager/CloudCliTokenManager") {}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

const readTokenResponse = Effect.fn("cloud.cli_token.read_token_response")(function* (
  response: HttpClientResponse.HttpClientResponse,
  params: Record<string, string>,
) {
  const body = yield* HttpClientResponse.schemaBodyJson(OAuthTokenResponse)(response);
  const now = yield* Clock.currentTimeMillis;
  const identity = idTokenIdentity(body.id_token);
  return {
    token: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? params.refresh_token ?? "",
      expiresAtEpochMs: now + body.expires_in * 1_000,
      ...(identity === null ? {} : { identity }),
    } satisfies PersistedToken,
    identity,
  };
});

const exchangeToken = Effect.fn("cloud.cli_token.exchange")(function* (
  metadata: Pick<CloudCliOAuthConfig, "tokenEndpoint">,
  params: Record<string, string>,
) {
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const startedAt = yield* Clock.monotonicTimeNanos;
  return yield* HttpClientRequest.post(metadata.tokenEndpoint).pipe(
    HttpClientRequest.bodyUrlParams(params),
    httpClient.execute,
    Effect.flatMap((response) => readTokenResponse(response, params)),
    Effect.timeout(OAUTH_REQUEST_TIMEOUT),
    Effect.catchTags({
      HttpClientError: (cause) =>
        Effect.gen(function* () {
          const reason = cause.reason;
          if (
            params.grant_type !== "refresh_token" ||
            reason._tag !== "StatusCodeError" ||
            !isPermanentRefreshStatus(reason.response.status)
          ) {
            return yield* cause;
          }
          // Reading a rejection body shares the exchange budget without losing
          // the known status when the body stalls or cannot be decoded.
          const elapsed = Duration.toMillis(
            Duration.nanos((yield* Clock.monotonicTimeNanos) - startedAt),
          );
          const body = yield* reason.response.json.pipe(
            Effect.timeout(Math.max(0, Duration.toMillis(OAUTH_REQUEST_TIMEOUT) - elapsed)),
            Effect.mapError(
              (cause) =>
                new CloudCliCredentialRefreshError({
                  status: reason.response.status,
                  cause: new HttpClientError.HttpClientError({
                    reason: new HttpClientError.StatusCodeError({
                      request: reason.request,
                      response: reason.response,
                      cause,
                    }),
                  }),
                }),
            ),
          );
          const diagnostic = decodeOAuthRefreshErrorResponse(body);
          return yield* new CloudCliCredentialRefreshError({
            cause,
            status: reason.response.status,
            ...(Option.isSome(diagnostic) ? { oauthErrorCode: diagnostic.value.error } : {}),
          });
        }),
    }),
  );
});

const makePkceRequest = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const verifier = Base64Url.encode(yield* crypto.randomBytes(32));
  const challenge = Base64Url.encode(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const state = Base64Url.encode(yield* crypto.randomBytes(16));
  return { verifier, challenge, state };
});

export interface DeviceAuthorizationPrompt {
  readonly verificationUri: string;
  readonly verificationUriComplete: string | undefined;
  readonly userCode: string;
  readonly expiresIn: Duration.Duration;
}

const isTransportError = (error: unknown) =>
  HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError";

const pollDeviceToken = Effect.fn("cloud.cli_token.poll_device_token")(function* (
  metadata: Pick<CloudCliOAuthConfig, "tokenEndpoint" | "clientId">,
  deviceCode: string,
  initialInterval: Duration.Duration,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const params = {
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: metadata.clientId,
  };
  let interval = initialInterval;
  while (true) {
    yield* Effect.sleep(interval);
    const response = yield* HttpClientRequest.post(metadata.tokenEndpoint).pipe(
      HttpClientRequest.bodyUrlParams(params),
      httpClient.execute,
      Effect.asSome,
      Effect.catchIf(isTransportError, () => Effect.succeedNone),
    );
    // Retry transport errors and 5xx while the device code is valid, backing off per RFC 8628 §3.5. Drain bodies to reuse connections.
    if (Option.isNone(response) || response.value.status >= 500) {
      if (Option.isSome(response)) yield* Effect.ignore(response.value.text);
      interval = Duration.sum(interval, DEVICE_AUTHORIZATION_SLOW_DOWN_INCREMENT);
      continue;
    }
    if (response.value.status >= 200 && response.value.status < 300) {
      return yield* readTokenResponse(response.value, params);
    }
    const failure = yield* HttpClientResponse.schemaBodyJson(OAuthErrorResponse)(response.value);
    switch (failure.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval = Duration.sum(interval, DEVICE_AUTHORIZATION_SLOW_DOWN_INCREMENT);
        continue;
      case "expired_token":
        return yield* new CloudCliAuthorizationTimeoutError({ cause: failure });
      case "access_denied":
        return yield* new CloudCliAuthorizationDeniedError();
      default:
        return yield* new CloudCliAuthorizationError({
          cause: failure.error_description ?? failure.error,
        });
    }
  }
});

export const deviceAuthorizationLogin = Effect.fn("cloud.cli_token.device_authorization_login")(
  function* <E, R>(showPrompt: (prompt: DeviceAuthorizationPrompt) => Effect.Effect<void, E, R>) {
    const metadata = yield* cloudCliOAuthConfig;
    const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const authorization = yield* HttpClientRequest.post(metadata.deviceAuthorizationEndpoint).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: metadata.clientId,
        scope: metadata.scopes.join(" "),
      }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(DeviceAuthorizationResponse)),
      Effect.timeout(OAUTH_REQUEST_TIMEOUT),
    );
    const expiresIn = Duration.seconds(authorization.expires_in);
    const interval =
      authorization.interval === undefined
        ? DEVICE_AUTHORIZATION_DEFAULT_INTERVAL
        : Duration.seconds(authorization.interval);
    yield* showPrompt({
      verificationUri: authorization.verification_uri,
      verificationUriComplete: authorization.verification_uri_complete,
      userCode: authorization.user_code,
      expiresIn,
    });
    return yield* pollDeviceToken(metadata, authorization.device_code, interval).pipe(
      Effect.timeout(expiresIn),
      Effect.catchTags({
        TimeoutError: (cause) => Effect.fail(new CloudCliAuthorizationTimeoutError({ cause })),
      }),
    );
  },
);

/** @public */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const services = Context.make(Crypto.Crypto, crypto).pipe(
    Context.add(HttpClient.HttpClient, httpClient),
  );
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const terminal = yield* Terminal.Terminal;
  const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
  const semaphore = yield* Semaphore.make(1);
  const persist = Effect.fn("cloud.cli_token.persist")(function* (token: PersistedToken) {
    const encoded = yield* encodePersistedToken(token);
    yield* secrets.set(CLOUD_CLI_OAUTH_TOKEN_SECRET, stringToBytes(encoded));
    return token;
  });

  const clear = secrets
    .remove(CLOUD_CLI_OAUTH_TOKEN_SECRET)
    .pipe(Effect.mapError((cause) => new CloudCliCredentialRemovalError({ cause })));

  const read = Effect.fn("cloud.cli_token.read")(function* () {
    const encoded = yield* secrets.get(CLOUD_CLI_OAUTH_TOKEN_SECRET);
    if (Option.isNone(encoded)) return Option.none<PersistedToken>();
    return Option.some(yield* decodePersistedToken(bytesToString(encoded.value)));
  });

  const refresh = Effect.fn("cloud.cli_token.refresh")(function* (token: PersistedToken) {
    const metadata = yield* cloudCliOAuthConfig;
    const { token: refreshed } = yield* exchangeToken(metadata, {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: metadata.clientId,
    });
    return refreshed.identity === undefined && token.identity !== undefined
      ? { ...refreshed, identity: token.identity }
      : refreshed;
  });

  const login = Effect.fn("cloud.cli_token.login")(function* () {
    const metadata = yield* cloudCliOAuthConfig;
    const hostedAppUrl = yield* hostedAppUrlConfig;
    const { verifier, challenge, state } = yield* makePkceRequest;
    const callback = yield* Deferred.make<string>();
    const layerCallbackRoute = HttpRouter.add(
      "GET",
      "/callback",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.originalUrl, metadata.redirectUri);
        const code = url.searchParams.get("code");
        if (url.searchParams.get("state") !== state || !code) {
          return HttpServerResponse.text("Invalid T3 Connect authorization callback.", {
            status: 400,
          });
        }
        yield* Deferred.succeed(callback, code);
        return HttpServerResponse.html(renderLoopbackAuthorizationCompleteHtml());
      }),
    );
    yield* HttpRouter.serve(layerCallbackRoute, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: metadata.loopbackPort,
          disablePreemptiveShutdown: true,
        }),
      ),
      Layer.build,
    );
    // /connect establishes a Clerk session first; /oauth/authorize loses parameters across sign-in.
    const authorizationUrl = buildConnectAuthorizeRequestUrl({
      hostedAppUrl,
      state,
      challenge,
      loopbackPort: metadata.loopbackPort,
    });
    yield* Console.log(formatLoopbackAuthorizationPrompt(authorizationUrl));
    const authorization = yield* waitForLoopbackAuthorization({
      authorizationUrl,
      callback: Deferred.await(callback).pipe(
        Effect.timeout(CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT),
        Effect.catchTags({
          TimeoutError: (cause) => Effect.fail(new CloudCliAuthorizationTimeoutError({ cause })),
        }),
      ),
      terminal,
      launchBrowser: externalLauncher.launchBrowser,
    });
    if (authorization._tag === "HeadlessRequested") {
      return authorization;
    }
    const { token } = yield* exchangeToken(metadata, {
      grant_type: "authorization_code",
      code: authorization.code,
      redirect_uri: metadata.redirectUri,
      client_id: metadata.clientId,
      code_verifier: verifier,
    });
    return { _tag: "Authorized", token } as const;
  });

  const getExistingNoLock = Effect.fn("cloud.cli_token.get_existing_no_lock")(function* () {
    const token = yield* read();
    if (Option.isNone(token)) return token;
    const now = yield* Clock.currentTimeMillis;
    if (token.value.expiresAtEpochMs - CLOUD_CLI_OAUTH_REFRESH_EARLY_MS > now) {
      return token;
    }
    return Option.some(
      // The endpoint can rotate the refresh token before shutdown interrupts us.
      // Keep the lock through persistence; the exchange still times out internally.
      yield* refresh(token.value).pipe(Effect.flatMap(persist), Effect.uninterruptible),
    );
  });

  const getExisting = semaphore.withPermits(1)(
    getExistingNoLock().pipe(
      Effect.mapError((cause) =>
        isCloudCliCredentialRefreshError(cause)
          ? cause
          : new CloudCliCredentialRefreshError({
              cause,
              ...(HttpClientError.isHttpClientError(cause) &&
              cause.reason._tag === "StatusCodeError"
                ? { status: cause.reason.response.status }
                : {}),
            }),
      ),
      Effect.provide(services),
    ),
  );
  const hasCredential = semaphore.withPermits(1)(
    read().pipe(
      Effect.map(Option.isSome),
      Effect.mapError((cause) => new CloudCliCredentialReadError({ cause })),
    ),
  );
  const get = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const token = yield* getExistingNoLock().pipe(
        Effect.orElseSucceed(() => Option.none<PersistedToken>()),
      );
      if (Option.isSome(token)) {
        return { _tag: "Authorized", token: token.value } as const;
      }
      const authorization = yield* Effect.scoped(login());
      return authorization._tag === "Authorized"
        ? ({ _tag: "Authorized", token: yield* persist(authorization.token) } as const)
        : authorization;
    }).pipe(
      Effect.mapError((cause) =>
        Terminal.isQuitError(cause) ? cause : new CloudCliAuthorizationError({ cause }),
      ),
      Effect.provide(services),
    ),
  );
  const store = Effect.fn("cloud.cli_token.store")(function* (token: PersistedToken) {
    yield* semaphore.withPermits(1)(
      persist(token).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new CloudCliAuthorizationError({ cause })),
      ),
    );
  });

  return CloudCliTokenManager.of({ get, getExisting, hasCredential, store, clear });
});

export const layer = Layer.effect(CloudCliTokenManager, make);
