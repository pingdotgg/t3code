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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
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
  // Clerk user id (`sub`). Absent on credentials stored before desktop
  // sign-in needed it; clientAuthState backfills it via /oauth/userinfo.
  accountId: Schema.optional(Schema.String),
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
 * Best-effort read of the identity claims from an OIDC id_token: `email` (or
 * fallback) to show the operator which account they linked, and `sub` as the
 * account id clients key relay data on. A malformed token degrades to nulls
 * rather than an error.
 */
function idTokenClaims(idToken: string | undefined): {
  readonly identity: string | null;
  readonly accountId: string | null;
} {
  const none = { identity: null, accountId: null };
  if (!idToken) return none;
  const payload = idToken.split(".")[1];
  if (!payload) return none;
  const decoded = Encoding.decodeBase64UrlString(payload);
  if (decoded._tag !== "Success") return none;
  const claims = decodeOidcIdentityClaimsJson(decoded.success);
  if (Option.isNone(claims)) return none;
  let identity: string | null = null;
  for (const value of [claims.value.email, claims.value.preferred_username, claims.value.sub]) {
    if (typeof value === "string" && value.length > 0) {
      identity = value;
      break;
    }
  }
  const sub = claims.value.sub;
  return { identity, accountId: typeof sub === "string" && sub.length > 0 ? sub : null };
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

/** Sign-in state as clients (desktop) see it, served over the connect HTTP API. */
export interface CloudCliClientAuthState {
  readonly authorized: boolean;
  readonly pendingLogin: boolean;
  readonly authorizationUrl: string | null;
  readonly accountId: string | null;
  readonly identity: string | null;
}

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
    readonly clientAuthState: Effect.Effect<CloudCliClientAuthState, CloudCliTokenManagerError>;
    readonly beginBrowserLogin: Effect.Effect<
      { readonly authorizationUrl: string },
      CloudCliTokenManagerError
    >;
    readonly submitBrowserLoginCode: (
      value: string,
    ) => Effect.Effect<
      { readonly accepted: true } | { readonly accepted: false; readonly reason: string }
    >;
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
  const { identity, accountId } = idTokenClaims(response.id_token);
  return {
    token: {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? params.refresh_token ?? "",
      expiresAtEpochMs: now + response.expires_in * 1_000,
      ...(identity === null ? {} : { identity }),
      ...(accountId === null ? {} : { accountId }),
    } satisfies PersistedToken,
    identity,
  };
});

const OAuthUserinfo = Schema.Struct({
  sub: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  preferred_username: Schema.optional(Schema.String),
});

const fetchUserinfo = Effect.fn("cloud.cli_token.fetch_userinfo")(function* (
  metadata: Pick<CloudCliOAuthConfig, "userinfoEndpoint">,
  accessToken: string,
) {
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  return yield* HttpClientRequest.get(metadata.userinfoEndpoint).pipe(
    HttpClientRequest.bearerToken(accessToken),
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(OAuthUserinfo)),
  );
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

/**
 * Starts the loopback OAuth callback listener for one authorization attempt
 * and returns an effect that resolves with the authorization code. The
 * listener lives until the surrounding scope closes; both the terminal login
 * and the desktop browser login run inside `Effect.scoped`.
 */
const makeLoopbackCallbackServer = Effect.fn("cloud.cli_token.loopback_callback_server")(function* (
  metadata: Pick<CloudCliOAuthConfig, "redirectUri" | "loopbackPort">,
  state: string,
) {
  const callback = yield* Deferred.make<string, CloudCliAuthorizationError>();
  const callbackRoute = HttpRouter.add(
    "GET",
    "/callback",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.originalUrl, metadata.redirectUri);
      const code = url.searchParams.get("code");
      const authorizationError = url.searchParams.get("error");
      if (url.searchParams.get("state") !== state || (!code && !authorizationError)) {
        return HttpServerResponse.text("Invalid T3 Connect authorization callback.", {
          status: 400,
        });
      }
      // A denied or cancelled authorization redirects with an error instead
      // of a code; fail the wait now rather than holding the attempt open
      // until the callback timeout.
      if (!code) {
        yield* Deferred.fail(
          callback,
          new CloudCliAuthorizationError({
            cause: `Clerk reported "${authorizationError}" instead of an authorization code.`,
          }),
        );
        return HttpServerResponse.text(
          "T3 Connect sign-in was not completed. You can close this tab.",
        );
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
        port: metadata.loopbackPort,
        disablePreemptiveShutdown: true,
      }),
    ),
    Layer.build,
  );
  return {
    awaitCode: Deferred.await(callback).pipe(
      Effect.timeout(CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(new CloudCliAuthorizationTimeoutError({ cause })),
      ),
    ),
  };
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

  const pendingLoginRef = yield* Ref.make(
    Option.none<{
      readonly authorizationUrl: string;
      readonly state: string;
      readonly manualCode: Deferred.Deferred<string, CloudCliAuthorizationError>;
    }>(),
  );
  const loginSemaphore = yield* Semaphore.make(1);
  const activeLoginFiberRef = yield* Ref.make(Option.none<Fiber.Fiber<void>>());

  // A sign-out must also cancel a waiting browser sign-in, or its late
  // completion would re-authorize the device. Cancelling here aborts the flow
  // before its exchange; an exchange already in flight is fenced off by the
  // still-current check its persist runs under this same semaphore.
  const clear = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const pending = yield* Ref.get(pendingLoginRef);
      if (Option.isSome(pending)) {
        yield* Deferred.fail(
          pending.value.manualCode,
          new CloudCliAuthorizationError({
            cause: "The pending sign-in was cancelled by a sign-out.",
          }),
        );
        yield* Ref.set(pendingLoginRef, Option.none());
      }
      yield* secrets.remove(CLOUD_CLI_OAUTH_TOKEN_SECRET);
    }).pipe(Effect.mapError((cause) => new CloudCliCredentialRemovalError({ cause }))),
  );

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
    // A refresh response may omit the id_token; keep the identity claims from
    // the original login in that case.
    return {
      ...refreshed,
      ...(refreshed.identity === undefined && token.identity !== undefined
        ? { identity: token.identity }
        : {}),
      ...(refreshed.accountId === undefined && token.accountId !== undefined
        ? { accountId: token.accountId }
        : {}),
    };
  });

  const login = Effect.fn("cloud.cli_token.login")(function* () {
    const metadata = yield* cloudCliOAuthConfig;
    const hostedAppUrl = yield* hostedAppUrlConfig;
    const { verifier, challenge, state } = yield* makePkceRequest;
    const { awaitCode } = yield* makeLoopbackCallbackServer(metadata, state);
    // The hosted /connect page establishes a Clerk session before forwarding
    // the request to /oauth/authorize with the loopback redirect URI. Sending
    // a signed-out browser to /oauth/authorize directly loses the authorize
    // parameters across Clerk's sign-in redirect (#5051).
    const authorizationUrl = buildConnectAuthorizeRequestUrl({
      hostedAppUrl,
      state,
      challenge,
      loopbackPort: metadata.loopbackPort,
    });
    yield* Console.log(formatLoopbackAuthorizationPrompt(authorizationUrl));
    const authorization = yield* waitForLoopbackAuthorization({
      authorizationUrl,
      callback: awaitCode,
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

  // Desktop sign-in: the same loopback authorization-code + PKCE flow as the
  // CLI, but with no terminal — the browser opens immediately and the
  // callback wait plus token exchange run in a detached fiber so the HTTP
  // handler that started the flow can return right away. Clients watch
  // clientAuthState to see the flow finish.
  const beginBrowserLogin = loginSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const pending = yield* Ref.get(pendingLoginRef);
      if (Option.isSome(pending)) {
        return pending.value;
      }
      // A cancelled attempt's fiber may still be releasing the loopback
      // port; wait for it to finish before binding again. This also orders
      // its pending-state cleanup strictly before this attempt registers.
      const previousFiber = yield* Ref.get(activeLoginFiberRef);
      if (Option.isSome(previousFiber)) {
        yield* Fiber.await(previousFiber.value);
      }
      const metadata = yield* cloudCliOAuthConfig;
      const hostedAppUrl = yield* hostedAppUrlConfig;
      const { verifier, challenge, state } = yield* makePkceRequest;
      const authorizationUrl = buildConnectAuthorizeRequestUrl({
        hostedAppUrl,
        state,
        challenge,
        loopbackPort: metadata.loopbackPort,
      });
      const manualCode = yield* Deferred.make<string, CloudCliAuthorizationError>();
      yield* Ref.set(pendingLoginRef, Option.some({ authorizationUrl, state, manualCode }));
      const loginFiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const { awaitCode } = yield* makeLoopbackCallbackServer(metadata, state);
          yield* externalLauncher
            .launchBrowser(authorizationUrl)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not open a browser for T3 Connect sign-in.", { cause }),
              ),
            );
          // A browser that lost the loopback port (e.g. a hosted app predating
          // #6285) lands on the out-of-band code page instead of the loopback
          // callback. A code pasted into the client completes the same
          // attempt — Clerk issued it against the hosted callback redirect
          // URI, so the exchange must name that URI.
          const authorization = yield* Effect.raceFirst(
            awaitCode.pipe(Effect.map((code) => ({ code, redirectUri: metadata.redirectUri }))),
            Deferred.await(manualCode).pipe(
              Effect.map((code) => ({ code, redirectUri: connectCallbackUrl(hostedAppUrl) })),
            ),
          );
          const { token } = yield* exchangeToken(metadata, {
            grant_type: "authorization_code",
            code: authorization.code,
            redirect_uri: authorization.redirectUri,
            client_id: metadata.clientId,
            code_verifier: verifier,
          });
          // The attempt may have been cancelled by a sign-out while the
          // exchange ran; only a still-current attempt may write the
          // credential, serialized with refresh and logout writes.
          yield* semaphore.withPermits(1)(
            Effect.gen(function* () {
              const currentPending = yield* Ref.get(pendingLoginRef);
              if (Option.isSome(currentPending) && currentPending.value.state === state) {
                yield* persist(token);
              }
            }),
          );
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("T3 Connect browser sign-in did not complete.", { cause }),
        ),
        // Compare-and-clear: a sign-out may have already replaced this
        // attempt with a newer one, whose pending state must survive this
        // fiber's death.
        Effect.ensuring(
          Ref.update(pendingLoginRef, (current) =>
            Option.isSome(current) && current.value.state === state ? Option.none() : current,
          ),
        ),
        Effect.forkDetach,
      );
      yield* Ref.set(activeLoginFiberRef, Option.some(loginFiber));
      return { authorizationUrl };
    }).pipe(
      Effect.mapError((cause) => new CloudCliAuthorizationError({ cause })),
      Effect.provide(services),
    ),
  );

  // Completes a pending browser login with a code pasted from the hosted
  // out-of-band page. Validation mirrors the CLI's headless prompt.
  const submitBrowserLoginCode = Effect.fn("cloud.cli_token.submit_browser_login_code")(function* (
    value: string,
  ) {
    const pending = yield* Ref.get(pendingLoginRef);
    if (Option.isNone(pending)) {
      return {
        accepted: false,
        reason: "No sign-in is waiting for a code. Start the sign-in again.",
      } as const;
    }
    const checked = checkConnectAuthCode(value.trim(), pending.value.state);
    if (typeof checked === "string") {
      return { accepted: false, reason: checked } as const;
    }
    const delivered = yield* Deferred.succeed(pending.value.manualCode, checked.code);
    if (!delivered) {
      return {
        accepted: false,
        reason: "A code was already submitted for this sign-in.",
      } as const;
    }
    return { accepted: true } as const;
  });

  const clientAuthState = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const pending = yield* Ref.get(pendingLoginRef);
      const pendingLogin = Option.isSome(pending);
      const authorizationUrl = Option.isSome(pending) ? pending.value.authorizationUrl : null;
      // Prefer a refreshed credential, but a refresh failure (offline,
      // revoked grant) must not report the stored sign-in as missing.
      const token = yield* getExistingNoLock().pipe(Effect.catch(() => read()));
      if (Option.isNone(token)) {
        return {
          authorized: false,
          pendingLogin,
          authorizationUrl,
          accountId: null,
          identity: null,
        } satisfies CloudCliClientAuthState;
      }
      let current = token.value;
      if (current.accountId === undefined) {
        // Credentials stored by `t3 connect` logins that predate desktop
        // sign-in lack the account id; backfill it once from Clerk's
        // userinfo endpoint so the same credential serves both.
        const metadata = yield* cloudCliOAuthConfig;
        const userinfo = yield* fetchUserinfo(metadata, current.accessToken).pipe(Effect.option);
        if (Option.isSome(userinfo) && userinfo.value.sub) {
          current = yield* persist({
            ...current,
            accountId: userinfo.value.sub,
            ...(current.identity === undefined &&
            (userinfo.value.email ?? userinfo.value.preferred_username)
              ? { identity: userinfo.value.email ?? userinfo.value.preferred_username }
              : {}),
          });
        }
      }
      return {
        authorized: true,
        pendingLogin,
        authorizationUrl,
        accountId: current.accountId ?? null,
        identity: current.identity ?? null,
      } satisfies CloudCliClientAuthState;
    }).pipe(
      Effect.mapError((cause) => new CloudCliCredentialReadError({ cause })),
      Effect.provide(services),
    ),
  );

  return CloudCliTokenManager.of({
    get,
    getExisting,
    hasCredential,
    store,
    clear,
    clientAuthState,
    beginBrowserLogin,
    submitBrowserLoginCode,
  });
});

export const layer = Layer.effect(CloudCliTokenManager, make);
