// @ts-nocheck
// @effect-diagnostics nodeBuiltinImport:off - The CLI loopback OAuth callback is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  buildConnectAuthorizeRequestUrl,
  buildConnectClerkAuthorizeUrl,
  checkConnectAuthCode,
  connectCallbackUrl,
} from "@t3tools/shared/connectAuth";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  cloudCliOAuthConfig,
  hostedAppUrlConfig,
  type CloudCliOAuthConfig,
} from "./publicConfig.ts";

const CLOUD_CLI_OAUTH_TOKEN_SECRET = "cloud-cli-oauth-token";
const CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT = Duration.minutes(10);
const CLOUD_CLI_OAUTH_REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(5));

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

const OidcIdentityClaimsJson = Schema.fromJsonString(
  Schema.Struct({
    email: Schema.optional(Schema.String),
    preferred_username: Schema.optional(Schema.String),
    sub: Schema.optional(Schema.String),
  }),
);
const decodeOidcIdentityClaims = Schema.decodeUnknownOption(OidcIdentityClaimsJson);

function idTokenIdentity(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  const decoded = Encoding.decodeBase64UrlString(payload);
  if (decoded._tag !== "Success") return null;
  const claims = decodeOidcIdentityClaims(decoded.success);
  if (Option.isNone(claims)) return null;
  return (
    [claims.value.email, claims.value.preferred_username, claims.value.sub].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    ) ?? null
  );
}

export const exchangeOAuthToken = Effect.fn("cloud.cli_token.exchange")(function* (
  metadata: CloudCliOAuthConfig,
  params: Record<string, string>,
) {
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const response = yield* HttpClientRequest.post(metadata.tokenEndpoint).pipe(
    HttpClientRequest.bodyUrlParams(params),
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(OAuthTokenResponse)),
  );
  const now = yield* Clock.currentTimeMillis;
  const identity = idTokenIdentity(response.id_token);
  return {
    token: {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? params.refresh_token ?? "",
      expiresAtEpochMs: now + response.expires_in * 1_000,
      ...(identity === null ? {} : { identity }),
    } satisfies PersistedToken,
    identity,
  };
});

export class CloudCliCredentialRemovalError extends Schema.TaggedErrorClass<CloudCliCredentialRemovalError>()(
  "CloudCliCredentialRemovalError",
  { cause: Schema.Unknown },
) {
  override get message(): string {
    return "Could not remove the stored T3 Connect CLI credential.";
  }
}

export class CloudCliCredentialRefreshError extends Schema.TaggedErrorClass<CloudCliCredentialRefreshError>()(
  "CloudCliCredentialRefreshError",
  { cause: Schema.Unknown },
) {
  override get message(): string {
    return "Could not refresh the T3 Connect CLI credential.";
  }
}

export class CloudCliCredentialReadError extends Schema.TaggedErrorClass<CloudCliCredentialReadError>()(
  "CloudCliCredentialReadError",
  { cause: Schema.Unknown },
) {
  override get message(): string {
    return "Could not read the stored T3 Connect CLI credential.";
  }
}

export class CloudCliAuthorizationError extends Schema.TaggedErrorClass<CloudCliAuthorizationError>()(
  "CloudCliAuthorizationError",
  { cause: Schema.Unknown },
) {
  override get message(): string {
    return "Could not authorize the T3 Connect CLI.";
  }
}

export class CloudCliAuthorizationTimeoutError extends Schema.TaggedErrorClass<CloudCliAuthorizationTimeoutError>()(
  "CloudCliAuthorizationTimeoutError",
  { cause: Schema.Unknown },
) {
  override get message(): string {
    return "Timed out waiting for T3 Connect authorization.";
  }
}

export const CloudCliTokenManagerError = Schema.Union([
  CloudCliCredentialRemovalError,
  CloudCliCredentialRefreshError,
  CloudCliCredentialReadError,
  CloudCliAuthorizationError,
  CloudCliAuthorizationTimeoutError,
]);
export type CloudCliTokenManagerError = typeof CloudCliTokenManagerError.Type;

export class CloudCliTokenManager extends Context.Service<
  CloudCliTokenManager,
  {
    readonly get: Effect.Effect<PersistedToken, CloudCliTokenManagerError>;
    readonly getExisting: Effect.Effect<Option.Option<PersistedToken>, CloudCliTokenManagerError>;
    readonly hasCredential: Effect.Effect<boolean, CloudCliTokenManagerError>;
    readonly store: (token: PersistedToken) => Effect.Effect<void, CloudCliTokenManagerError>;
    readonly clear: Effect.Effect<void, CloudCliTokenManagerError>;
  }
>()("t3/cloud/CliTokenManager/CloudCliTokenManager") {}

const wrapError =
  <WrappedError extends CloudCliTokenManagerError>(makeError: (cause: unknown) => WrappedError) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, WrappedError, R> =>
    effect.pipe(Effect.mapError(makeError));

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

interface LoopbackAuthorizationCallback {
  readonly awaitCode: Effect.Effect<string>;
}

export const withLoopbackAuthorizationCallback = <A, E, R>(
  input: {
    readonly redirectUri: string;
    readonly state: string;
  },
  use: (callback: LoopbackAuthorizationCallback) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const callback = yield* Deferred.make<string>();
      const redirectUri = new URL(input.redirectUri);
      const server = yield* Effect.tryPromise({
        try: () =>
          new Promise<NodeHttp.Server>((resolve, reject) => {
            const listener = NodeHttp.createServer((request, response) => {
              const url = new URL(request.url ?? "/", input.redirectUri);
              const code = url.searchParams.get("code");
              if (
                request.method !== "GET" ||
                url.pathname !== redirectUri.pathname ||
                url.searchParams.get("state") !== input.state ||
                !code
              ) {
                response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
                response.end("Invalid T3 Connect authorization callback.");
                return;
              }
              Effect.runSync(Deferred.succeed(callback, code));
              response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
              response.end("<h1>T3 Connect authorization complete</h1>");
            });
            listener.once("error", reject);
            listener.listen(
              {
                host: redirectUri.hostname,
                port: Number(redirectUri.port),
              },
              () => resolve(listener),
            );
          }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      return { callback, server };
    }),
    ({ callback }) => use({ awaitCode: Deferred.await(callback) }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ).pipe(Effect.orDie),
  );

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const semaphore = yield* Semaphore.make(1);
  const persist = Effect.fn("cloud.cli_token.persist")(function* (token: PersistedToken) {
    const encoded = yield* encodePersistedToken(token);
    yield* secrets.set(CLOUD_CLI_OAUTH_TOKEN_SECRET, stringToBytes(encoded));
    return token;
  });

  const clear = secrets
    .remove(CLOUD_CLI_OAUTH_TOKEN_SECRET)
    .pipe(wrapError((cause) => new CloudCliCredentialRemovalError({ cause })));

  const read = Effect.fn("cloud.cli_token.read")(function* () {
    const encoded = yield* secrets.get(CLOUD_CLI_OAUTH_TOKEN_SECRET);
    if (Option.isNone(encoded)) return Option.none<PersistedToken>();
    return Option.some(yield* decodePersistedToken(bytesToString(encoded.value)));
  });

  const refresh = Effect.fn("cloud.cli_token.refresh")(function* (token: PersistedToken) {
    const metadata = yield* cloudCliOAuthConfig;
    const { token: refreshed } = yield* exchangeOAuthToken(metadata, {
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
    const verifier = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
    const challenge = Encoding.encodeBase64Url(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const state = Encoding.encodeBase64Url(yield* crypto.randomBytes(16));
    const authorizationUrl = buildConnectClerkAuthorizeUrl({
      authorizationEndpoint: metadata.authorizationEndpoint,
      clientId: metadata.clientId,
      redirectUri: metadata.redirectUri,
      scopes: metadata.scopes,
      state,
      challenge,
    });
    const code = yield* withLoopbackAuthorizationCallback(
      { redirectUri: metadata.redirectUri, state },
      ({ awaitCode }) =>
        Console.log(`Open this URL to authorize T3 Connect:\n${authorizationUrl}\n`).pipe(
          Effect.andThen(
            awaitCode.pipe(
              Effect.timeout(CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT),
              Effect.catchTag("TimeoutError", (cause) =>
                Effect.fail(
                  new CloudCliAuthorizationTimeoutError({
                    cause,
                  }),
                ),
              ),
            ),
          ),
        ),
    );
    return (yield* exchangeOAuthToken(metadata, {
      grant_type: "authorization_code",
      code,
      redirect_uri: metadata.redirectUri,
      client_id: metadata.clientId,
      code_verifier: verifier,
    })).token;
  });

  const getExistingNoLock = Effect.fn("cloud.cli_token.get_existing_no_lock")(function* () {
    const token = yield* read();
    if (Option.isNone(token)) return token;
    const now = yield* Clock.currentTimeMillis;
    if (token.value.expiresAtEpochMs - CLOUD_CLI_OAUTH_REFRESH_EARLY_MS > now) {
      return token;
    }
    return Option.some(yield* refresh(token.value).pipe(Effect.flatMap(persist)));
  });

  const getExisting = semaphore.withPermits(1)(
    getExistingNoLock().pipe(wrapError((cause) => new CloudCliCredentialRefreshError({ cause }))),
  );
  const hasCredential = semaphore.withPermits(1)(
    read().pipe(
      Effect.map(Option.isSome),
      wrapError((cause) => new CloudCliCredentialReadError({ cause })),
    ),
  );
  const get = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const token = yield* getExistingNoLock().pipe(Effect.orElseSucceed(() => Option.none()));
      return Option.isSome(token)
        ? token.value
        : yield* Effect.scoped(login()).pipe(Effect.flatMap(persist));
    }).pipe(wrapError((cause) => new CloudCliAuthorizationError({ cause }))),
  );
  const store = (token: PersistedToken) =>
    semaphore.withPermits(1)(
      persist(token).pipe(
        Effect.asVoid,
        wrapError((cause) => new CloudCliAuthorizationError({ cause })),
      ),
    );

  return CloudCliTokenManager.of({ get, getExisting, hasCredential, store, clear });
});

export const layer = Layer.effect(CloudCliTokenManager, make);

export interface OutOfBandOAuthPromptInput {
  readonly authorizeUrl: string;
  readonly validate: (value: string) => Effect.Effect<string, string>;
}

export const outOfBandOAuthLogin = Effect.fn("cloud.cli_token.out_of_band_oauth_login")(function* <
  E,
  R,
>(promptForCode: (input: OutOfBandOAuthPromptInput) => Effect.Effect<string, E, R>) {
  const crypto = yield* Crypto.Crypto;
  const metadata = yield* cloudCliOAuthConfig;
  const hostedAppUrl = yield* hostedAppUrlConfig;
  const verifier = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
  const challenge = Encoding.encodeBase64Url(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const state = Encoding.encodeBase64Url(yield* crypto.randomBytes(16));
  const value = yield* promptForCode({
    authorizeUrl: buildConnectAuthorizeRequestUrl({ hostedAppUrl, state, challenge }),
    validate: (candidate) => {
      const checked = checkConnectAuthCode(candidate, state);
      return typeof checked === "string" ? Effect.fail(checked) : Effect.succeed(candidate);
    },
  });
  const checked = checkConnectAuthCode(value, state);
  if (typeof checked === "string") {
    return yield* Effect.fail(new CloudCliAuthorizationError({ cause: checked }));
  }
  return yield* exchangeOAuthToken(metadata, {
    grant_type: "authorization_code",
    code: checked.code,
    redirect_uri: connectCallbackUrl(hostedAppUrl),
    client_id: metadata.clientId,
    code_verifier: verifier,
  });
});
