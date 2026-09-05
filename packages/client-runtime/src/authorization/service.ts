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
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

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
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpopHttp: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly rejectedAccessToken?: string;
    }) => Effect.Effect<AuthorizedRemoteHttpEnvironment, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

const CACHED_ENDPOINT_SOCKET_TIMEOUT_MS = 3_000;
const BEARER_DESCRIPTOR_CACHE_TTL_MS = 10_000;
const DPOP_AUTHORIZATION_TIMEOUT_MS = 30_000;

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
  const bearerDescriptors = yield* Ref.make<
    ReadonlyMap<
      EnvironmentId,
      {
        readonly httpBaseUrl: string;
        readonly descriptor: ExecutionEnvironmentDescriptor;
        readonly validatedAtEpochMs: number;
      }
    >
  >(new Map());

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
      const now = yield* Clock.currentTimeMillis;
      const cachedDescriptor = (yield* Ref.get(bearerDescriptors)).get(input.expectedEnvironmentId);
      const canReuseDescriptor =
        cachedDescriptor?.httpBaseUrl === input.httpBaseUrl &&
        cachedDescriptor.validatedAtEpochMs + BEARER_DESCRIPTOR_CACHE_TTL_MS > now;
      const descriptor = canReuseDescriptor
        ? cachedDescriptor.descriptor
        : yield* fetchDescriptor(input.httpBaseUrl, input.connectionMethod).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      if (!canReuseDescriptor) {
        yield* Ref.update(bearerDescriptors, (current) => {
          const next = new Map(current);
          next.set(input.expectedEnvironmentId, {
            httpBaseUrl: input.httpBaseUrl,
            descriptor,
            validatedAtEpochMs: now,
          });
          return next;
        });
      }
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
        httpAuthorization: {
          _tag: "Bearer" as const,
          token: input.bearerToken,
        },
      };
    },
  );

  const createDpopSocketUrl = Effect.fn("clientRuntime.connection.remote.createDpopSocketUrl")(
    function* (token: TokenStore.RemoteDpopAccessToken, timeoutMs?: number) {
      const ticketProof = yield* signer
        .createProof({
          method: "POST",
          url: environmentEndpointUrl(token.endpoint.httpBaseUrl, "/api/auth/websocket-ticket"),
          accessToken: token.accessToken,
        })
        .pipe(
          Effect.mapError(
            () =>
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "Could not create the websocket authorization proof.",
              }),
          ),
        );
      return yield* resolveRemoteDpopWebSocketConnectionUrl({
        wsBaseUrl: token.endpoint.wsBaseUrl,
        httpBaseUrl: token.endpoint.httpBaseUrl,
        accessToken: token.accessToken,
        dpopProof: ticketProof,
        clientMetadata: presentation.metadata,
        connectionMethod: "relay",
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    },
  );

  const sessionChanged = () =>
    new ConnectionBlockedError({
      reason: "authentication",
      detail: "Your cloud sign-in changed. Sign in again to authorize the environment.",
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
        scopes: presentation.scopes,
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
        dpopThumbprint: thumbprint,
      });
    },
  );

  const getDpopToken = Effect.fn("clientRuntime.connection.remote.getDpopToken")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpopHttp"]>[0],
  ) {
    const session = yield* cloudSession.identity;
    if (Option.isNone(session)) {
      return yield* sessionChanged();
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
          return { token: Effect.succeed(cached.value), fromCache: true };
        }
        if (input.rejectedAccessToken !== undefined) {
          yield* removeRejectedToken(input.expectedEnvironmentId, input.rejectedAccessToken);
        }
        const pending = pendingTokens.get(input.expectedEnvironmentId);
        if (pending?.identity === identity && pending.thumbprint === thumbprint) {
          return { token: pending.token, fromCache: false };
        }

        const id = {};
        const fiber = yield* exchangeDpopToken(
          input.expectedEnvironmentId,
          thumbprint,
          identity,
        ).pipe(
          Effect.flatMap((token) =>
            tokenLock.withPermits(1)(
              Effect.gen(function* () {
                yield* assertSession(identity);
                yield* tokenStore
                  .put(token)
                  .pipe(Effect.withSpan("environment.authorization.accessToken.persist"));
                const current = yield* cloudSession.identity;
                if (Option.isNone(current) || current.value !== identity) {
                  yield* removeRejectedToken(input.expectedEnvironmentId, token.accessToken);
                  return yield* sessionChanged();
                }
                tokenOwners.set(input.expectedEnvironmentId, {
                  accessToken: token.accessToken,
                  identity,
                });
                if (pendingTokens.get(input.expectedEnvironmentId)?.id === id) {
                  pendingTokens.delete(input.expectedEnvironmentId);
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
                if (pendingTokens.get(input.expectedEnvironmentId)?.id === id) {
                  pendingTokens.delete(input.expectedEnvironmentId);
                }
              }),
            ),
          ),
          // One caller's timeout must not cancel renewal for other HTTP requests.
          Effect.forkIn(serviceScope),
        );
        const token = Fiber.join(fiber);
        pendingTokens.set(input.expectedEnvironmentId, { id, identity, thumbprint, token });
        return { token, fromCache: false };
      }),
    );
    yield* Effect.annotateCurrentSpan({
      "connection.remote_token_cache": selected.fromCache ? "hit" : "miss",
    });
    const token = yield* selected.token;
    yield* assertSession(identity);
    return { token, fromCache: selected.fromCache, identity };
  });

  const httpAuthorization = (
    token: TokenStore.RemoteDpopAccessToken,
  ): AuthorizedRemoteHttpEnvironment => ({
    environmentId: token.environmentId,
    label: token.label,
    httpBaseUrl: token.endpoint.httpBaseUrl,
    httpAuthorization: {
      _tag: "Dpop",
      accessToken: token.accessToken,
      expiresAtEpochMs: token.expiresAtEpochMs,
    },
  });

  const authorizeDpop = Effect.fn("clientRuntime.connection.remote.authorizeDpop")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpop"]>[0],
  ) {
    let selected = yield* getDpopToken(input);
    if (selected.fromCache) {
      const cachedSocket = yield* createDpopSocketUrl(
        selected.token,
        CACHED_ENDPOINT_SOCKET_TIMEOUT_MS,
      ).pipe(Effect.result);
      if (Result.isSuccess(cachedSocket)) {
        yield* assertSession(selected.identity);
        return { ...httpAuthorization(selected.token), socketUrl: cachedSocket.success };
      }
      if (cachedSocket.failure._tag === "ConnectionBlockedError") {
        return yield* mapDpopSocketError(cachedSocket.failure);
      }
      selected = yield* getDpopToken({
        ...input,
        rejectedAccessToken: selected.token.accessToken,
      });
    }
    const socket = yield* createDpopSocketUrl(selected.token).pipe(Effect.result);
    if (Result.isFailure(socket)) {
      yield* tokenLock.withPermits(1)(
        removeRejectedToken(input.expectedEnvironmentId, selected.token.accessToken),
      );
      return yield* mapDpopSocketError(socket.failure);
    }
    yield* assertSession(selected.identity);
    return { ...httpAuthorization(selected.token), socketUrl: socket.success };
  });

  return RemoteEnvironmentAuthorization.of({
    authorizeBearer,
    authorizeDpop: (input) =>
      authorizeDpop(input).pipe(Effect.withSpan("environment.authorization")),
    authorizeDpopHttp: (input) =>
      getDpopToken(input).pipe(
        Effect.map(({ token }) => httpAuthorization(token)),
        Effect.withSpan("environment.authorization.http"),
        withRelayClientTracing,
      ),
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
