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
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Terminal from "effect/Terminal";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  buildConnectAuthorizeRequestUrl,
  buildConnectClerkAuthorizeUrl,
  checkConnectAuthCode,
  connectCallbackUrl,
} from "@t3tools/shared/connectAuth";

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
const boldTerminalText = (value: string): string => `\u001b[1m${value}\u001b[22m`;

export function formatLoopbackAuthorizationPrompt(authorizationUrl: string): string {
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

export const waitForLoopbackAuthorization = Effect.fn(
  "cloud.cli_token.wait_for_loopback_authorization",
)(function* <E, R>(input: {
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
            Effect.map(
              (code): LoopbackAuthorizationResult => ({ _tag: "AuthorizationCode", code }),
            ),
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
});

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
const decodeOidcIdentityClaimsJson = Schema.decodeUnknownOption(OidcIdentityClaimsJson);

/**
 * Best-effort read of the `email` (or fallback) claim from an OIDC id_token.
 * Only used to show the operator which account they linked, so a malformed
 * token degrades to "no identity" rather than an error.
 */
function idTokenIdentity(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  const decoded = Encoding.decodeBase64UrlString(payload);
  if (decoded._tag !== "Success") return null;
  const claims = decodeOidcIdentityClaimsJson(decoded.success);
  if (Option.isNone(claims)) return null;
  for (const value of [claims.value.email, claims.value.preferred_username, claims.value.sub]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export class CloudCliCredentialRemovalError extends Schema.TaggedErrorClass<CloudCliCredentialRemovalError>()(
  "CloudCliCredentialRemovalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not remove the stored T3 Connect CLI credential.";
  }
}

export class CloudCliCredentialRefreshError extends Schema.TaggedErrorClass<CloudCliCredentialRefreshError>()(
  "CloudCliCredentialRefreshError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not refresh the T3 Connect CLI credential.";
  }
}

export class CloudCliCredentialReadError extends Schema.TaggedErrorClass<CloudCliCredentialReadError>()(
  "CloudCliCredentialReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the stored T3 Connect CLI credential.";
  }
}

export class CloudCliAuthorizationError extends Schema.TaggedErrorClass<CloudCliAuthorizationError>()(
  "CloudCliAuthorizationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not authorize the T3 Connect CLI.";
  }
}

export class CloudCliAuthorizationTimeoutError extends Schema.TaggedErrorClass<CloudCliAuthorizationTimeoutError>()(
  "CloudCliAuthorizationTimeoutError",
  { cause: Schema.Defect() },
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

const exchangeToken = Effect.fn("cloud.cli_token.exchange")(function* (
  metadata: Pick<CloudCliOAuthConfig, "tokenEndpoint">,
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

const makePkceRequest = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const verifier = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
  const challenge = Encoding.encodeBase64Url(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const state = Encoding.encodeBase64Url(yield* crypto.randomBytes(16));
  return { verifier, challenge, state };
});

export interface OutOfBandOAuthPromptInput {
  readonly authorizeUrl: string;
  readonly validate: (value: string) => Effect.Effect<string, string>;
}

/**
 * Out-of-band OAuth for machines without a local browser (SSH). The user
 * opens the hosted /connect URL elsewhere, signs in, and enters the displayed
 * code in this terminal. The PKCE verifier never leaves this process, so the
 * authorization code is useless to an observer, and the state bundled into
 * the blob preserves the loopback flow's CSRF check.
 */
export const outOfBandOAuthLogin = Effect.fn("cloud.cli_token.out_of_band_oauth_login")(function* <
  E,
  R,
>(promptForCode: (input: OutOfBandOAuthPromptInput) => Effect.Effect<string, E, R>) {
  const metadata = yield* cloudCliOAuthConfig;
  const hostedAppUrl = yield* hostedAppUrlConfig;
  const { verifier, challenge, state } = yield* makePkceRequest;

  const authorizationCode = yield* promptForCode({
    authorizeUrl: buildConnectAuthorizeRequestUrl({ hostedAppUrl, state, challenge }),
    validate: (value) => {
      const checked = checkConnectAuthCode(value, state);
      return typeof checked === "string" ? Effect.fail(checked) : Effect.succeed(value);
    },
  }).pipe(
    // Clerk authorization codes expire on this horizon anyway; matching the
    // loopback flow's timeout turns an abandoned prompt into a clear error.
    Effect.timeout(CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT),
    Effect.catchTag("TimeoutError", (cause) =>
      Effect.fail(new CloudCliAuthorizationTimeoutError({ cause })),
    ),
  );
  // promptForCode is caller-supplied, so re-check the returned value rather
  // than trusting that the prompt ran validate.
  const authCode = checkConnectAuthCode(authorizationCode, state);
  if (typeof authCode === "string") {
    return yield* new CloudCliAuthorizationError({ cause: authCode });
  }

  return yield* exchangeToken(metadata, {
    grant_type: "authorization_code",
    code: authCode.code,
    redirect_uri: connectCallbackUrl(hostedAppUrl),
    client_id: metadata.clientId,
    code_verifier: verifier,
  });
});

export const make = Effect.gen(function* () {
  // Capture exactly the services the login/refresh flows need at build time
  // (matching the behavior before the out-of-band flow captured the instances), not
  // the whole ambient context.
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
    const { verifier, challenge, state } = yield* makePkceRequest;
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
        return HttpServerResponse.html(renderLoopbackAuthorizationCompleteHtml());
      }),
    );
    yield* HttpRouter.serve(callbackRoute, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 34338,
          disablePreemptiveShutdown: true,
        }),
      ),
      Layer.build,
    );
    const authorizationUrl = buildConnectClerkAuthorizeUrl({
      authorizationEndpoint: metadata.authorizationEndpoint,
      clientId: metadata.clientId,
      redirectUri: metadata.redirectUri,
      scopes: metadata.scopes,
      state,
      challenge,
    });
    yield* Console.log(formatLoopbackAuthorizationPrompt(authorizationUrl));
    const authorization = yield* waitForLoopbackAuthorization({
      authorizationUrl,
      callback: Deferred.await(callback).pipe(
        Effect.timeout(CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT),
        Effect.catchTag("TimeoutError", (cause) =>
          Effect.fail(new CloudCliAuthorizationTimeoutError({ cause })),
        ),
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
    return Option.some(yield* refresh(token.value).pipe(Effect.flatMap(persist)));
  });

  const getExisting = semaphore.withPermits(1)(
    getExistingNoLock().pipe(
      Effect.mapError((cause) => new CloudCliCredentialRefreshError({ cause })),
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
      // A stored credential that can't be read or refreshed (corrupt, revoked,
      // expired grant) must fall through to a fresh login rather than dead-end
      // the command — authorizeCli applies the same fallback to out-of-band
      // authorization.
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
