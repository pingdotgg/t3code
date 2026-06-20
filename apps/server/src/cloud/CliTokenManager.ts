// @effect-diagnostics nodeBuiltinImport:off - The CLI loopback OAuth callback is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
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
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cloudCliOAuthConfig, type CloudCliOAuthConfig } from "./publicConfig.ts";

const CLOUD_CLI_OAUTH_TOKEN_SECRET = "cloud-cli-oauth-token";
const CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT = Duration.minutes(10);
const CLOUD_CLI_OAUTH_REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(5));
const CLOUD_CLI_OAUTH_CALLBACK_HOST = "127.0.0.1";
const CLOUD_CLI_OAUTH_CALLBACK_PORT = 34338;

const PersistedToken = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
});
type PersistedToken = typeof PersistedToken.Type;

const PersistedTokenJson = Schema.fromJsonString(PersistedToken);
const decodePersistedToken = Schema.decodeUnknownEffect(PersistedTokenJson);
const encodePersistedToken = Schema.encodeEffect(PersistedTokenJson);

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  token_type: Schema.String,
});

type CredentialReadFailure = ServerSecretStore.SecretStoreReadError | Schema.SchemaError;

type CredentialPersistFailure =
  | Schema.SchemaError
  | ServerSecretStore.SecretStoreTemporaryPathGenerationError
  | ServerSecretStore.SecretStorePersistError;

const CloudCliCredentialRefreshStage = Schema.Literals([
  "read-credential",
  "decode-credential",
  "load-oauth-config",
  "exchange-token",
  "encode-credential",
  "persist-credential",
]);

const CloudCliAuthorizationStage = Schema.Literals([
  "load-oauth-config",
  "prepare-pkce",
  "start-callback-server",
  "exchange-token",
  "encode-credential",
  "persist-credential",
]);

export class CloudCliCredentialRemovalError extends Schema.TaggedErrorClass<CloudCliCredentialRemovalError>()(
  "CloudCliCredentialRemovalError",
  {
    secretName: Schema.Literal(CLOUD_CLI_OAUTH_TOKEN_SECRET),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not remove the stored T3 Connect CLI credential ${this.secretName}.`;
  }
}

export class CloudCliCredentialRefreshError extends Schema.TaggedErrorClass<CloudCliCredentialRefreshError>()(
  "CloudCliCredentialRefreshError",
  {
    stage: CloudCliCredentialRefreshStage,
    secretName: Schema.Literal(CLOUD_CLI_OAUTH_TOKEN_SECRET),
    tokenEndpoint: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static fromCredentialRead(cause: CredentialReadFailure): CloudCliCredentialRefreshError {
    return new CloudCliCredentialRefreshError({
      stage: cause._tag === "SecretStoreReadError" ? "read-credential" : "decode-credential",
      secretName: CLOUD_CLI_OAUTH_TOKEN_SECRET,
      cause,
    });
  }

  static fromCredentialPersist(cause: CredentialPersistFailure): CloudCliCredentialRefreshError {
    return new CloudCliCredentialRefreshError({
      stage: cause._tag === "SchemaError" ? "encode-credential" : "persist-credential",
      secretName: CLOUD_CLI_OAUTH_TOKEN_SECRET,
      cause,
    });
  }

  override get message(): string {
    const tokenEndpoint = this.tokenEndpoint ? ` using ${this.tokenEndpoint}` : "";
    return `Could not refresh the T3 Connect CLI credential ${this.secretName} during ${this.stage}${tokenEndpoint}.`;
  }
}

export class CloudCliCredentialReadError extends Schema.TaggedErrorClass<CloudCliCredentialReadError>()(
  "CloudCliCredentialReadError",
  {
    stage: Schema.Literals(["read-credential", "decode-credential"]),
    secretName: Schema.Literal(CLOUD_CLI_OAUTH_TOKEN_SECRET),
    cause: Schema.Defect(),
  },
) {
  static fromCredentialRead(cause: CredentialReadFailure): CloudCliCredentialReadError {
    return new CloudCliCredentialReadError({
      stage: cause._tag === "SecretStoreReadError" ? "read-credential" : "decode-credential",
      secretName: CLOUD_CLI_OAUTH_TOKEN_SECRET,
      cause,
    });
  }

  override get message(): string {
    return `Could not inspect the stored T3 Connect CLI credential ${this.secretName} during ${this.stage}.`;
  }
}

export class CloudCliAuthorizationError extends Schema.TaggedErrorClass<CloudCliAuthorizationError>()(
  "CloudCliAuthorizationError",
  {
    stage: CloudCliAuthorizationStage,
    secretName: Schema.Literal(CLOUD_CLI_OAUTH_TOKEN_SECRET),
    tokenEndpoint: Schema.optional(Schema.String),
    redirectUri: Schema.optional(Schema.String),
    callbackHost: Schema.optional(Schema.String),
    callbackPort: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  static fromCredentialPersist(cause: CredentialPersistFailure): CloudCliAuthorizationError {
    return new CloudCliAuthorizationError({
      stage: cause._tag === "SchemaError" ? "encode-credential" : "persist-credential",
      secretName: CLOUD_CLI_OAUTH_TOKEN_SECRET,
      cause,
    });
  }

  override get message(): string {
    const tokenEndpoint = this.tokenEndpoint ? ` using ${this.tokenEndpoint}` : "";
    const redirectUri = this.redirectUri ? ` with callback ${this.redirectUri}` : "";
    const callbackAddress =
      this.callbackHost && this.callbackPort !== undefined
        ? ` on ${this.callbackHost}:${this.callbackPort}`
        : "";
    return `Could not authorize the T3 Connect CLI credential ${this.secretName} during ${this.stage}${tokenEndpoint}${redirectUri}${callbackAddress}.`;
  }
}

export class CloudCliAuthorizationTimeoutError extends Schema.TaggedErrorClass<CloudCliAuthorizationTimeoutError>()(
  "CloudCliAuthorizationTimeoutError",
  {
    redirectUri: Schema.String,
    timeoutMillis: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Timed out after ${this.timeoutMillis}ms waiting for T3 Connect authorization at ${this.redirectUri}.`;
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
    readonly get: Effect.Effect<
      PersistedToken,
      | CloudCliCredentialRefreshError
      | CloudCliAuthorizationError
      | CloudCliAuthorizationTimeoutError
    >;
    readonly getExisting: Effect.Effect<
      Option.Option<PersistedToken>,
      CloudCliCredentialRefreshError
    >;
    readonly hasCredential: Effect.Effect<boolean, CloudCliCredentialReadError>;
    readonly clear: Effect.Effect<void, CloudCliCredentialRemovalError>;
  }
>()("t3/cloud/CliTokenManager/CloudCliTokenManager") {}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const semaphore = yield* Semaphore.make(1);
  const persist = Effect.fn("cloud.cli_token.persist")(function* (token: PersistedToken) {
    const encoded = yield* encodePersistedToken(token);
    yield* secrets.set(CLOUD_CLI_OAUTH_TOKEN_SECRET, stringToBytes(encoded));
    return token;
  });

  const clear = secrets.remove(CLOUD_CLI_OAUTH_TOKEN_SECRET).pipe(
    Effect.mapError(
      (cause) =>
        new CloudCliCredentialRemovalError({
          secretName: CLOUD_CLI_OAUTH_TOKEN_SECRET,
          cause,
        }),
    ),
  );

  const read = Effect.fn("cloud.cli_token.read")(function* () {
    const encoded = yield* secrets.get(CLOUD_CLI_OAUTH_TOKEN_SECRET);
    if (Option.isNone(encoded)) return Option.none<PersistedToken>();
    return Option.some(yield* decodePersistedToken(bytesToString(encoded.value)));
  });

  const exchangeToken = Effect.fn("cloud.cli_token.exchange")(function* (
    metadata: CloudCliOAuthConfig,
    params: Record<string, string>,
  ) {
    const response = yield* HttpClientRequest.post(metadata.tokenEndpoint).pipe(
      HttpClientRequest.bodyUrlParams(params),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(OAuthTokenResponse)),
    );
    const now = yield* Clock.currentTimeMillis;
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? params.refresh_token ?? "",
      expiresAtEpochMs: now + response.expires_in * 1_000,
    } satisfies PersistedToken;
  });

  const refresh = Effect.fn("cloud.cli_token.refresh")(function* (token: PersistedToken) {
    const metadata = yield* cloudCliOAuthConfig.pipe(
      Effect.mapError(
        (cause) =>
          new CloudCliCredentialRefreshError({
            stage: "load-oauth-config",
            secretName: CLOUD_CLI_OAUTH_TOKEN_SECRET,
            cause,
          }),
      ),
    );
    return yield* exchangeToken(metadata, {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: metadata.clientId,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CloudCliCredentialRefreshError({
            stage: "exchange-token",
            secretName: CLOUD_CLI_OAUTH_TOKEN_SECRET,
            tokenEndpoint: metadata.tokenEndpoint,
            cause,
          }),
      ),
    );
  });

  const login = Effect.fn("cloud.cli_token.login")(function* () {
    const metadata = yield* cloudCliOAuthConfig.pipe(
      Effect.mapError(
        (cause) =>
          new CloudCliAuthorizationError({
            stage: "load-oauth-config",
            secretName: CLOUD_CLI_OAUTH_TOKEN_SECRET,
            cause,
          }),
      ),
    );
    const { challenge, state, verifier } = yield* Effect.gen(function* () {
      const verifier = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
      const challenge = Encoding.encodeBase64Url(
        yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
      );
      const state = yield* crypto.randomUUIDv4;
      return { challenge, state, verifier };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CloudCliAuthorizationError({
            stage: "prepare-pkce",
            secretName: CLOUD_CLI_OAUTH_TOKEN_SECRET,
            redirectUri: metadata.redirectUri,
            cause,
          }),
      ),
    );
    const callback = yield* Deferred.make<string>();
    const callbackRoute = HttpRouter.add(
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
        return yield* HttpServerResponse.html`
<html>
  <body style="font-family: sans-serif; text-align: center; margin-top: 50px;">
    <h1>T3 Connect authorization complete</h1>
    <p>You can close this window and return to your terminal.</p>
  </body>
</html>
`;
      }),
    );
    yield* HttpRouter.serve(callbackRoute, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: CLOUD_CLI_OAUTH_CALLBACK_HOST,
          port: CLOUD_CLI_OAUTH_CALLBACK_PORT,
          disablePreemptiveShutdown: true,
        }),
      ),
      Layer.build,
      Effect.mapError(
        (cause) =>
          new CloudCliAuthorizationError({
            stage: "start-callback-server",
            secretName: CLOUD_CLI_OAUTH_TOKEN_SECRET,
            redirectUri: metadata.redirectUri,
            callbackHost: CLOUD_CLI_OAUTH_CALLBACK_HOST,
            callbackPort: CLOUD_CLI_OAUTH_CALLBACK_PORT,
            cause,
          }),
      ),
    );
    const authorizationUrl = new URL(metadata.authorizationEndpoint);
    authorizationUrl.searchParams.set("client_id", metadata.clientId);
    authorizationUrl.searchParams.set("redirect_uri", metadata.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", metadata.scopes.join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    yield* Console.log(`Open this URL to authorize T3 Connect:\n${authorizationUrl.toString()}\n`);
    const code = yield* Deferred.await(callback).pipe(
      Effect.timeout(CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(
            new CloudCliAuthorizationTimeoutError({
              redirectUri: metadata.redirectUri,
              timeoutMillis: Duration.toMillis(CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT),
              cause,
            }),
          ),
      }),
    );
    return yield* exchangeToken(metadata, {
      grant_type: "authorization_code",
      code,
      redirect_uri: metadata.redirectUri,
      client_id: metadata.clientId,
      code_verifier: verifier,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CloudCliAuthorizationError({
            stage: "exchange-token",
            secretName: CLOUD_CLI_OAUTH_TOKEN_SECRET,
            tokenEndpoint: metadata.tokenEndpoint,
            redirectUri: metadata.redirectUri,
            cause,
          }),
      ),
    );
  });

  const getExistingNoLock = Effect.fn("cloud.cli_token.get_existing_no_lock")(function* () {
    const token = yield* read().pipe(
      Effect.mapError(CloudCliCredentialRefreshError.fromCredentialRead),
    );
    if (Option.isNone(token)) return token;
    const now = yield* Clock.currentTimeMillis;
    if (token.value.expiresAtEpochMs - CLOUD_CLI_OAUTH_REFRESH_EARLY_MS > now) {
      return token;
    }
    return Option.some(
      yield* refresh(token.value).pipe(
        Effect.flatMap((refreshed) =>
          persist(refreshed).pipe(
            Effect.mapError(CloudCliCredentialRefreshError.fromCredentialPersist),
          ),
        ),
      ),
    );
  });

  const getExisting = semaphore.withPermits(1)(getExistingNoLock());
  const hasCredential = semaphore.withPermits(1)(
    read().pipe(
      Effect.map(Option.isSome),
      Effect.mapError(CloudCliCredentialReadError.fromCredentialRead),
    ),
  );
  const get = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const token = yield* getExistingNoLock();
      return Option.isSome(token)
        ? token.value
        : yield* Effect.scoped(login()).pipe(
            Effect.flatMap((authorized) =>
              persist(authorized).pipe(
                Effect.mapError(CloudCliAuthorizationError.fromCredentialPersist),
              ),
            ),
          );
    }),
  );

  return CloudCliTokenManager.of({ get, getExisting, hasCredential, clear });
});

export const layer = Layer.effect(CloudCliTokenManager, make);
