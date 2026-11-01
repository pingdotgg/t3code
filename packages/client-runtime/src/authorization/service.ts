import {
  type ClientConnectionMethod,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { RelayEnvironmentConnectScope } from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import {
  exchangeRemoteDpopAccessToken,
  type RemoteEnvironmentAuthError,
  resolveRemoteDpopWebSocketConnectionUrl,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";
import {
  environmentMismatchError,
  mapManagedRelayError,
  mapRemoteDpopEnvironmentError,
  mapRemoteEnvironmentError,
} from "../connection/errors.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as TokenStore from "./tokenStore.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import {
  DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
  readonly descriptor?: ExecutionEnvironmentDescriptor;
}

export interface AuthorizedRemoteHttpEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: Extract<PreparedHttpAuthorization, { readonly _tag: "Dpop" }>;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpop: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      /**
       * The access token is not bound to an origin, and each proof is minted
       * for the URL it signs, so a token from the relay also works on the
       * environment's LAN or tailnet address.
       */
      readonly directEndpoint?: { readonly httpBaseUrl: string; readonly wsBaseUrl: string };
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpopHttp: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly rejectedAccessToken?: string;
      /** The request goes to a LAN or tailnet address rather than through T3 Connect. */
      readonly direct?: boolean;
    }) => Effect.Effect<AuthorizedRemoteHttpEnvironment, ConnectionAttemptError>;
    /**
     * Renews a live socket's token before it expires, so the server moves the
     * socket to the new session instead of closing it. Runs until interrupted.
     */
    readonly renewDpopBeforeExpiry: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly expiresAtEpochMs: number;
    }) => Effect.Effect<void, ConnectionBlockedError>;
  }
>()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

const CACHED_ENDPOINT_SOCKET_TIMEOUT_MS = 3_000;
const DPOP_AUTHORIZATION_TIMEOUT_MS = 30_000;
// Tokens outlive this so direct routes survive a sleeping client or an unreachable relay;
// renewing at this age through the relay is what ends access for a removed Connect member.
const DPOP_ACCESS_TOKEN_RENEW_AFTER_MS = 60 * 60 * 1_000;
const DPOP_ACCESS_TOKEN_RENEW_RETRY_MS = 5 * 60 * 1_000;

function mapDpopSocketError(error: RemoteEnvironmentAuthError | ConnectionAttemptError) {
  return error._tag === "ConnectionTransientError" || error._tag === "ConnectionBlockedError"
    ? error
    : mapRemoteDpopEnvironmentError(error);
}

const fetchDescriptor = Effect.fn("clientRuntime.connection.remote.fetchDescriptor")(function* (
  httpBaseUrl: string,
  connectionMethod: ClientConnectionMethod,
) {
  return yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError((error) => mapRemoteEnvironmentError(error, connectionMethod)),
  );
});

export const make = Effect.gen(function* () {
  const serviceScope = yield* Scope.Scope;
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const cloudSession = yield* ClientCapabilities.CloudSession;
  const deviceIdentity = yield* ClientCapabilities.RelayDeviceIdentity;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const tokenStore = yield* TokenStore.RemoteDpopAccessTokenStore;
  const httpClient = yield* HttpClient.HttpClient;
  const tokenLock = yield* Semaphore.make(1);
  const tokenOwners = new Map<
    EnvironmentId,
    { readonly accessToken: string; readonly identity: ClientCapabilities.CloudSessionIdentity }
  >();
  const pendingTokens = new Map<
    EnvironmentId,
    {
      readonly id: object;
      readonly identity: ClientCapabilities.CloudSessionIdentity;
      readonly thumbprint: string;
      readonly token: Effect.Effect<TokenStore.RemoteDpopAccessToken, ConnectionAttemptError>;
    }
  >();

  /**
   * A saved LAN address can belong to another machine on a different network.
   */
  const verifyDirectEndpoint = Effect.fn("clientRuntime.connection.remote.verifyDirectEndpoint")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const descriptor = yield* fetchDescriptor(input.httpBaseUrl, input.connectionMethod).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      return descriptor;
    },
  );

  const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeBearer"]
      >[0]["expectedEnvironmentId"];
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const descriptor = yield* verifyDirectEndpoint(input);
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: input.wsBaseUrl,
        httpBaseUrl: input.httpBaseUrl,
        bearerToken: input.bearerToken,
        clientMetadata: presentation.metadata,
        connectionMethod: input.connectionMethod,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl,
        descriptor,
        httpAuthorization: {
          _tag: "Bearer" as const,
          token: input.bearerToken,
        },
      };
    },
  );

  const createDpopSocketUrl = Effect.fn("clientRuntime.connection.remote.createDpopSocketUrl")(
    function* (
      token: TokenStore.RemoteDpopAccessToken,
      timeoutMs?: number,
      endpoint: { readonly httpBaseUrl: string; readonly wsBaseUrl: string } = token.endpoint,
    ) {
      return yield* resolveRemoteDpopWebSocketConnectionUrl({
        wsBaseUrl: endpoint.wsBaseUrl,
        httpBaseUrl: endpoint.httpBaseUrl,
        accessToken: token.accessToken,
        createProof: (proof) =>
          signer.createProof(proof).pipe(
            Effect.mapError(
              () =>
                new ConnectionBlockedError({
                  reason: "configuration",
                  detail: "Could not create the websocket authorization proof.",
                }),
            ),
          ),
        clientMetadata: presentation.metadata,
        connectionMethod: "relay",
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    },
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );

  const sessionChanged = () =>
    new ConnectionBlockedError({
      reason: "authentication",
      detail: "Your cloud sign-in changed. Sign in again to authorize the environment.",
    });

  // A missing identity before the attempt captures one means the cloud session
  // is still loading, not a sign-out. Only a captured identity that goes away
  // or changes is evidence of one.
  const sessionPending = () =>
    new ConnectionTransientError({
      reason: "session-pending",
      detail: "Waiting for the T3 Connect sign-in to load.",
    });

  const assertSession = Effect.fnUntraced(function* (
    identity: ClientCapabilities.CloudSessionIdentity,
  ) {
    const current = yield* cloudSession.identity;
    if (Option.isNone(current) || current.value !== identity) {
      return yield* sessionChanged();
    }
  });

  // Called under tokenLock so a late rejection cannot remove a newer credential.
  const removeRejectedToken = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    accessToken: string,
  ) {
    const cached = yield* tokenStore.get(environmentId);
    if (Option.isSome(cached) && cached.value.accessToken === accessToken) {
      yield* tokenStore.remove(environmentId);
      tokenOwners.delete(environmentId);
    }
  });

  const obtainBootstrap = Effect.fn("relay.connection.bootstrap.obtain")(function* (
    environmentId: EnvironmentId,
    identity: ClientCapabilities.CloudSessionIdentity,
  ) {
    yield* assertSession(identity);
    const clerkToken = yield* cloudSession.clerkToken.pipe(
      Effect.withSpan("relay.connection.cloudSessionToken.resolve"),
    );
    const deviceId = yield* deviceIdentity.deviceId.pipe(
      Effect.withSpan("relay.connection.deviceIdentity.resolve"),
    );
    yield* assertSession(identity);
    const connected = yield* relay
      .connectEnvironment({
        clerkToken,
        scopes: [RelayEnvironmentConnectScope],
        environmentId,
        ...(Option.isSome(deviceId) ? { deviceId: deviceId.value } : {}),
      })
      .pipe(Effect.mapError(mapManagedRelayError));
    if (connected.environmentId !== environmentId) {
      return yield* environmentMismatchError({
        expected: environmentId,
        actual: connected.environmentId,
      });
    }
    yield* assertSession(identity);
    return connected;
  });

  const exchangeDpopToken = Effect.fn("clientRuntime.connection.remote.exchangeDpopToken")(
    function* (
      environmentId: EnvironmentId,
      thumbprint: string,
      identity: ClientCapabilities.CloudSessionIdentity,
    ) {
      const bootstrap = yield* obtainBootstrap(environmentId, identity);
      const descriptor = yield* fetchDescriptor(bootstrap.endpoint.httpBaseUrl, "relay").pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.descriptor"),
      );
      if (descriptor.environmentId !== environmentId) {
        return yield* environmentMismatchError({
          expected: environmentId,
          actual: descriptor.environmentId,
        });
      }
      const bootstrapProof = yield* signer
        .createProof({
          method: "POST",
          url: environmentEndpointUrl(bootstrap.endpoint.httpBaseUrl, "/oauth/token"),
        })
        .pipe(
          Effect.mapError(
            () =>
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "Could not create the environment authorization proof.",
              }),
          ),
        );
      yield* assertSession(identity);
      const access = yield* exchangeRemoteDpopAccessToken({
        httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
        credential: bootstrap.credential,
        dpopProof: bootstrapProof,
        clientMetadata: presentation.metadata,
      }).pipe(
        Effect.mapError(mapRemoteDpopEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.accessToken.exchange"),
      );
      const issuedAt = yield* Clock.currentTimeMillis;
      return new TokenStore.RemoteDpopAccessToken({
        environmentId: descriptor.environmentId,
        accountId: identity.accountId,
        label: descriptor.label,
        endpoint: bootstrap.endpoint,
        accessToken: access.access_token,
        expiresAtEpochMs: issuedAt + access.expires_in * 1_000,
        issuedAtEpochMs: issuedAt,
        dpopThumbprint: thumbprint,
      });
    },
  );

  // Must run under tokenLock: it registers the pending exchange other callers join.
  const startExchange = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    thumbprint: string,
    identity: ClientCapabilities.CloudSessionIdentity,
  ) {
    const id = {};
    const fiber = yield* exchangeDpopToken(environmentId, thumbprint, identity).pipe(
      Effect.flatMap((token) =>
        tokenLock.withPermits(1)(
          Effect.gen(function* () {
            yield* assertSession(identity);
            yield* tokenStore
              .put(token)
              .pipe(Effect.withSpan("environment.authorization.accessToken.persist"));
            const current = yield* cloudSession.identity;
            if (Option.isNone(current) || current.value !== identity) {
              yield* removeRejectedToken(environmentId, token.accessToken);
              return yield* sessionChanged();
            }
            tokenOwners.set(environmentId, {
              accessToken: token.accessToken,
              identity,
            });
            if (pendingTokens.get(environmentId)?.id === id) {
              pendingTokens.delete(environmentId);
            }
            return token;
          }),
        ),
      ),
      Effect.timeoutOrElse({
        duration: DPOP_AUTHORIZATION_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new ConnectionTransientError({
              reason: "timeout",
              detail: "Timed out renewing the environment credential.",
            }),
          ),
      }),
      Effect.ensuring(
        tokenLock.withPermits(1)(
          Effect.sync(() => {
            if (pendingTokens.get(environmentId)?.id === id) {
              pendingTokens.delete(environmentId);
            }
          }),
        ),
      ),
      // One caller's timeout must not cancel renewal for other HTTP requests.
      Effect.forkIn(serviceScope),
    );
    const token = Fiber.join(fiber);
    pendingTokens.set(environmentId, { id, identity, thumbprint, token });
    return { token };
  });

  const renewalAttempts = new Map<EnvironmentId, number>();

  // A refused renewal means the Connect member or link was removed, so the cached token goes
  // too. Anything else, including a lapsed sign-in, keeps LAN and tailnet access.
  const renewInBackground = Effect.fnUntraced(function* (
    cached: TokenStore.RemoteDpopAccessToken,
    thumbprint: string,
    identity: ClientCapabilities.CloudSessionIdentity,
    now: number,
  ) {
    const issuedAt = cached.issuedAtEpochMs;
    if (issuedAt !== undefined && now - issuedAt < DPOP_ACCESS_TOKEN_RENEW_AFTER_MS) return;
    if (pendingTokens.has(cached.environmentId)) return;
    const lastAttempt = renewalAttempts.get(cached.environmentId);
    if (lastAttempt !== undefined && now - lastAttempt < DPOP_ACCESS_TOKEN_RENEW_RETRY_MS) return;
    renewalAttempts.set(cached.environmentId, now);
    const renewal = yield* startExchange(cached.environmentId, thumbprint, identity);
    yield* renewal.token.pipe(
      Effect.catch((error) =>
        error._tag === "ConnectionBlockedError" && error.reason === "permission"
          ? Effect.gen(function* () {
              const current = yield* cloudSession.identity;
              if (Option.isNone(current) || current.value !== identity) return;
              yield* tokenLock.withPermits(1)(
                removeRejectedToken(cached.environmentId, cached.accessToken),
              );
            })
          : Effect.void,
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.remote.renewDpopToken"),
      Effect.forkIn(serviceScope),
    );
  });

  // The environment issued this token itself, so a lapsed or missing cloud sign-in must not cut
  // off LAN and tailnet access before the token expires. T3 Connect routes still require sign-in.
  const getDpopTokenWithoutSession = Effect.fnUntraced(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpopHttp"]>[0],
  ) {
    const thumbprint = yield* signer.thumbprint.pipe(Effect.option);
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* tokenLock.withPermits(1)(
      Effect.gen(function* () {
        if (input.rejectedAccessToken !== undefined) {
          yield* removeRejectedToken(input.expectedEnvironmentId, input.rejectedAccessToken);
        }
        return yield* tokenStore.get(input.expectedEnvironmentId);
      }),
    );
    if (
      Option.isSome(thumbprint) &&
      Option.isSome(cached) &&
      cached.value.environmentId === input.expectedEnvironmentId &&
      cached.value.dpopThumbprint === thumbprint.value &&
      cached.value.expiresAtEpochMs > now + DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS
    ) {
      yield* Effect.annotateCurrentSpan({ "connection.remote_token_cache": "hit-without-session" });
      return { token: cached.value, fromCache: true, identity: Option.none() };
    }
    return yield* sessionChanged();
  });

  const getDpopToken = Effect.fn("clientRuntime.connection.remote.getDpopToken")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpopHttp"]>[0],
  ) {
    const session = yield* cloudSession.identity;
    if (Option.isNone(session)) {
      return yield* input.direct === true ? getDpopTokenWithoutSession(input) : sessionPending();
    }
    const identity = session.value;
    const thumbprint = yield* signer.thumbprint.pipe(
      Effect.mapError(
        () =>
          new ConnectionBlockedError({
            reason: "configuration",
            detail: "Could not load the environment authorization key.",
          }),
      ),
      Effect.withSpan("environment.authorization.dpopKey.resolve"),
    );
    const selected = yield* tokenLock.withPermits(1)(
      Effect.gen(function* () {
        yield* assertSession(identity);
        const now = yield* Clock.currentTimeMillis;
        const cached = yield* tokenStore
          .get(input.expectedEnvironmentId)
          .pipe(Effect.withSpan("environment.authorization.accessToken.cache"));
        const owner = tokenOwners.get(input.expectedEnvironmentId);
        if (
          Option.isSome(cached) &&
          cached.value.environmentId === input.expectedEnvironmentId &&
          cached.value.accountId === identity.accountId &&
          cached.value.dpopThumbprint === thumbprint &&
          cached.value.expiresAtEpochMs > now + DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS &&
          cached.value.accessToken !== input.rejectedAccessToken &&
          (owner?.accessToken !== cached.value.accessToken || owner.identity === identity)
        ) {
          tokenOwners.set(input.expectedEnvironmentId, {
            accessToken: cached.value.accessToken,
            identity,
          });
          yield* renewInBackground(cached.value, thumbprint, identity, now);
          return { token: Effect.succeed(cached.value), fromCache: true };
        }
        if (input.rejectedAccessToken !== undefined) {
          yield* removeRejectedToken(input.expectedEnvironmentId, input.rejectedAccessToken);
        }
        const pending = pendingTokens.get(input.expectedEnvironmentId);
        if (pending?.identity === identity && pending.thumbprint === thumbprint) {
          return { token: pending.token, fromCache: false };
        }

        const { token } = yield* startExchange(input.expectedEnvironmentId, thumbprint, identity);
        return { token, fromCache: false };
      }),
    );
    yield* Effect.annotateCurrentSpan({
      "connection.remote_token_cache": selected.fromCache ? "hit" : "miss",
    });
    const token = yield* selected.token;
    yield* assertSession(identity);
    return { token, fromCache: selected.fromCache, identity: Option.some(identity) };
  });

  const httpAuthorization = (
    token: TokenStore.RemoteDpopAccessToken,
    httpBaseUrl = token.endpoint.httpBaseUrl,
  ): AuthorizedRemoteHttpEnvironment => ({
    environmentId: token.environmentId,
    label: token.label,
    httpBaseUrl,
    httpAuthorization: {
      _tag: "Dpop",
      accessToken: token.accessToken,
      expiresAtEpochMs: token.expiresAtEpochMs,
    },
  });

  const authorizeDpop = Effect.fn("clientRuntime.connection.remote.authorizeDpop")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpop"]>[0],
  ) {
    const endpoint = input.directEndpoint;
    const descriptor =
      endpoint === undefined
        ? undefined
        : yield* verifyDirectEndpoint({
            expectedEnvironmentId: input.expectedEnvironmentId,
            httpBaseUrl: endpoint.httpBaseUrl,
            connectionMethod: "direct",
          });
    const authorized = (token: TokenStore.RemoteDpopAccessToken, socketUrl: string) => ({
      ...httpAuthorization(token, endpoint?.httpBaseUrl),
      socketUrl,
      ...(descriptor === undefined ? {} : { descriptor }),
    });
    const tokenInput = { ...input, direct: endpoint !== undefined };
    let selected = yield* getDpopToken(tokenInput);
    if (selected.fromCache) {
      const cachedSocket = yield* createDpopSocketUrl(
        selected.token,
        CACHED_ENDPOINT_SOCKET_TIMEOUT_MS,
        endpoint,
      ).pipe(Effect.result);
      if (Result.isSuccess(cachedSocket)) {
        if (Option.isSome(selected.identity)) yield* assertSession(selected.identity.value);
        return authorized(selected.token, cachedSocket.success);
      }
      if (cachedSocket.failure._tag === "ConnectionBlockedError") {
        return yield* mapDpopSocketError(cachedSocket.failure);
      }
      // An unreachable direct address says nothing about the token, so keep
      // it for the T3 Connect route rather than forcing a relay round trip.
      if (endpoint !== undefined && cachedSocket.failure._tag !== "EnvironmentAuthInvalidError") {
        return yield* mapDpopSocketError(cachedSocket.failure);
      }
      if (Option.isSome(selected.identity)) yield* assertSession(selected.identity.value);
      selected = yield* getDpopToken({
        ...tokenInput,
        rejectedAccessToken: selected.token.accessToken,
      });
    }
    const socket = yield* createDpopSocketUrl(selected.token, undefined, endpoint).pipe(
      Effect.result,
    );
    if (Result.isFailure(socket)) {
      if (endpoint === undefined || socket.failure._tag === "ConnectionBlockedError") {
        yield* tokenLock.withPermits(1)(
          removeRejectedToken(input.expectedEnvironmentId, selected.token.accessToken),
        );
      }
      return yield* mapDpopSocketError(socket.failure);
    }
    if (Option.isSome(selected.identity)) yield* assertSession(selected.identity.value);
    return authorized(selected.token, socket.success);
  });

  return RemoteEnvironmentAuthorization.of({
    authorizeBearer,
    authorizeDpop: Effect.fn("environment.authorization")(function (input) {
      return authorizeDpop(input);
    }),
    // The relay tracer must wrap span creation, not just the token request.
    authorizeDpopHttp: Effect.fnUntraced(function* (input) {
      return yield* getDpopToken(input).pipe(
        Effect.map(({ token }) => httpAuthorization(token)),
        Effect.withSpan("environment.authorization.http"),
        withRelayClientTracing,
      );
    }),
    // Untraced: a span here would stay open for the socket's lifetime. Each renewal has its own.
    renewDpopBeforeExpiry: Effect.fnUntraced(function* (input) {
      let expiresAtEpochMs = input.expiresAtEpochMs;
      let now = yield* Clock.currentTimeMillis;
      // Past expiry the server has closed the socket.
      while (now < expiresAtEpochMs) {
        // getDpopToken reuses a cached token until it is within the skew of expiry.
        // The floor spaces out retries and keeps a wall-clock jump from spinning.
        yield* Effect.sleep(
          Math.max(5_000, expiresAtEpochMs - DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS - now),
        );
        const renewed = yield* getDpopToken({
          expectedEnvironmentId: input.expectedEnvironmentId,
        }).pipe(
          Effect.map(({ token }) => token.expiresAtEpochMs),
          Effect.withSpan("environment.authorization.renewSocket"),
          withRelayClientTracing,
          // A relay blip retries until expiry; a blocked credential ends the loop.
          Effect.catchTags({ ConnectionTransientError: () => Effect.succeed(expiresAtEpochMs) }),
        );
        expiresAtEpochMs = Math.max(expiresAtEpochMs, renewed);
        now = yield* Clock.currentTimeMillis;
      }
    }),
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
