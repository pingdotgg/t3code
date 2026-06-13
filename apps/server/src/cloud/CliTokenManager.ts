// @effect-diagnostics nodeBuiltinImport:off - The CLI loopback OAuth callback is a Node HTTP boundary.
import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cloudCliOAuthConfig, type CloudCliOAuthConfig } from "./publicConfig.ts";

const CLOUD_CLI_OAUTH_TOKEN_SECRET = "cloud-cli-oauth-token";
const CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT = Duration.minutes(10);
const CLOUD_CLI_OAUTH_REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(5));

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

export class CloudCliTokenManagerError extends Data.TaggedError("CloudCliTokenManagerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface CloudCliTokenManagerShape {
  readonly get: Effect.Effect<PersistedToken, CloudCliTokenManagerError>;
  readonly getExisting: Effect.Effect<Option.Option<PersistedToken>, CloudCliTokenManagerError>;
  readonly hasCredential: Effect.Effect<boolean, CloudCliTokenManagerError>;
  readonly clear: Effect.Effect<void, CloudCliTokenManagerError>;
}

export class CloudCliTokenManager extends Context.Service<
  CloudCliTokenManager,
  CloudCliTokenManagerShape
>()("t3/cloud/CliTokenManager/CloudCliTokenManager") {}

const wrapError =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, CloudCliTokenManagerError, R> =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new CloudCliTokenManagerError({
            message,
            cause,
          }),
      ),
    );

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const semaphore = yield* Semaphore.make(1);
  const persist = Effect.fn("cloud.cli_token.persist")(function* (token: PersistedToken) {
    const encoded = yield* encodePersistedToken(token);
    yield* secrets.set(CLOUD_CLI_OAUTH_TOKEN_SECRET, stringToBytes(encoded));
    return token;
  });

  const clear = secrets
    .remove(CLOUD_CLI_OAUTH_TOKEN_SECRET)
    .pipe(wrapError("Could not remove the stored T3 Connect CLI credential."));

  const read = Effect.fn("cloud.cli_token.read")(function* () {
    const encoded = yield* secrets.get(CLOUD_CLI_OAUTH_TOKEN_SECRET);
    if (!encoded) return Option.none<PersistedToken>();
    return Option.some(yield* decodePersistedToken(bytesToString(encoded)));
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
    const metadata = yield* cloudCliOAuthConfig;
    return yield* exchangeToken(metadata, {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: metadata.clientId,
    });
  });

  const login = Effect.fn("cloud.cli_token.login")(function* () {
    const metadata = yield* cloudCliOAuthConfig;
    const verifier = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
    const challenge = Encoding.encodeBase64Url(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const state = yield* crypto.randomUUIDv4;
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
        NodeHttpServer.layer(createServer, {
          host: "127.0.0.1",
          port: 34338,
          disablePreemptiveShutdown: true,
        }),
      ),
      Layer.build,
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
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new CloudCliTokenManagerError({
            message: "Timed out waiting for T3 Connect authorization.",
          }),
        ),
      ),
    );
    return yield* exchangeToken(metadata, {
      grant_type: "authorization_code",
      code,
      redirect_uri: metadata.redirectUri,
      client_id: metadata.clientId,
      code_verifier: verifier,
    });
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
    getExistingNoLock().pipe(wrapError("Could not refresh the T3 Connect CLI credential.")),
  );
  const hasCredential = semaphore.withPermits(1)(
    read().pipe(
      Effect.map(Option.isSome),
      wrapError("Could not read the stored T3 Connect CLI credential."),
    ),
  );
  const get = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const token = yield* getExistingNoLock();
      return Option.isSome(token)
        ? token.value
        : yield* Effect.scoped(login()).pipe(Effect.flatMap(persist));
    }).pipe(wrapError("Could not authorize the T3 Connect CLI.")),
  );

  return CloudCliTokenManager.of({ get, getExisting, hasCredential, clear });
});

export const layer = Layer.effect(CloudCliTokenManager, make);
