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

/** Reuse a prior tunnel host's label when connect returns the same endpoint. */
const RELAY_ENDPOINT_HINT_TTL_MS = 15 * 60_000;

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
      /** Treat cached tokens as stale this far before expiry. Defaults to the live-socket skew. */
      readonly refreshSkewMs?: number;
    }) => Effect.Effect<AuthorizedRemoteHttpEnvironment, ConnectionAttemptError>;
    /** Lets the next direct authorization of this address skip its own descriptor read. */
    readonly rememberCheckedDescriptor: (
      httpBaseUrl: string,
      descriptor: Option.Option<ExecutionEnvironmentDescriptor>,
    ) => Effect.Effect<void>;
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
const CHECKED_DESCRIPTOR_TTL_NANOS = 5_000_000_000n;

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
  const lastRelayEndpoints = new Map<
    EnvironmentId,
    {
      readonly accountId: string;
      readonly label: string;
      readonly endpoint: TokenStore.RemoteDpopAccessToken["endpoint"];
      readonly atEpochMs: number;
    }
  >();

  const rememberRelayEndpoint = (token: TokenStore.RemoteDpopAccessToken, atEpochMs: number) => {
    if (token.accountId === undefined) return;
    lastRelayEndpoints.set(token.environmentId, {
      accountId: token.accountId,
      label: token.label,
      endpoint: token.endpoint,
      atEpochMs,
    });
  };

  const sameRelayEndpoint = (
    left: TokenStore.RemoteDpopAccessToken["endpoint"],
    right: TokenStore.RemoteDpopAccessToken["endpoint"],
  ) => left.httpBaseUrl === right.httpBaseUrl && left.wsBaseUrl === right.wsBaseUrl;

  // A route or host check hands its descriptor to the connect it leads to, once,
  // so the connect skips a round trip. Only over HTTPS: a plain LAN address can
  // belong to another machine after a network change.
  const checkedDescriptors = new Map<
    string,
    { readonly descriptor: ExecutionEnvironmentDescriptor; readonly at: bigint }
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
      const checked = checkedDescriptors.get(input.httpBaseUrl);
      checkedDescriptors.delete(input.httpBaseUrl);
      // A remembered mismatch still reads again, so a host that answers for the
      // right environment a moment later is not blocked.
      const descriptor =
        checked !== undefined &&
        checked.descriptor.environmentId === input.expectedEnvironmentId &&
        (yield* Clock.monotonicTimeNanos) - checked.at <= CHECKED_DESCRIPTOR_TTL_NANOS
          ? checked.descriptor
          : yield* fetchDescriptor(input.httpBaseUrl, input.connectionMethod).pipe(
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
    const [clerkToken, deviceId] = yield* Effect.all(
      [
        cloudSession.clerkToken.pipe(Effect.withSpan("relay.connection.cloudSessionToken.resolve")),
        deviceIdentity.deviceId.pipe(Effect.withSpan("relay.connection.deviceIdentity.resolve")),
      ],
      { concurrency: 2 },
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

  const createBootstrapProof = Effect.fnUntraced(function* (httpBaseUrl: string) {
    return yield* signer
      .createProof({
        method: "POST",
        url: environmentEndpointUrl(httpBaseUrl, "/oauth/token"),
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
  });

  const exchangeDpopToken = Effect.fn("clientRuntime.connection.remote.exchangeDpopToken")(
    function* (
      environmentId: EnvironmentId,
      thumbprint: string,
      identity: ClientCapabilities.CloudSessionIdentity,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const priorToken = yield* tokenStore.get(environmentId);
      const storedHint = lastRelayEndpoints.get(environmentId);
      // A still-stored token is authoritative for its endpoint. The TTL only
      // bounds the in-memory hint after the token row was cleared.
      const reusableHint =
        Option.isSome(priorToken) &&
        priorToken.value.accountId === identity.accountId &&
        priorToken.value.dpopThumbprint === thumbprint
          ? {
              accountId: identity.accountId,
              label: priorToken.value.label,
              endpoint: priorToken.value.endpoint,
              atEpochMs: now,
            }
          : storedHint !== undefined &&
              storedHint.accountId === identity.accountId &&
              now - storedHint.atEpochMs < RELAY_ENDPOINT_HINT_TTL_MS
            ? storedHint
            : undefined;

      // Mint the DPoP proof against the last tunnel host while the relay assigns
      // a bootstrap credential; most renewals land on the same endpoint.
      const speculativeProof =
        reusableHint === undefined
          ? undefined
          : yield* Effect.forkChild(createBootstrapProof(reusableHint.endpoint.httpBaseUrl));
      const bootstrap = yield* obtainBootstrap(environmentId, identity);
      const endpointReused =
        reusableHint !== undefined && sameRelayEndpoint(reusableHint.endpoint, bootstrap.endpoint);
      yield* Effect.annotateCurrentSpan({
        "connection.relay_endpoint_cache": endpointReused ? "hit" : "miss",
      });

      if (speculativeProof !== undefined && !endpointReused) {
        yield* Fiber.interrupt(speculativeProof).pipe(Effect.ignore);
      }

      const labelAndProof: { readonly label: string; readonly proof: string } = endpointReused
        ? {
            label: reusableHint.label,
            proof:
              speculativeProof !== undefined
                ? yield* Fiber.join(speculativeProof)
                : yield* createBootstrapProof(bootstrap.endpoint.httpBaseUrl),
          }
        : yield* Effect.all(
            {
              label: fetchDescriptor(bootstrap.endpoint.httpBaseUrl, "relay").pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.withSpan("environment.authorization.descriptor"),
                Effect.flatMap((descriptor) =>
                  descriptor.environmentId === environmentId
                    ? Effect.succeed(descriptor.label)
                    : environmentMismatchError({
                        expected: environmentId,
                        actual: descriptor.environmentId,
                      }),
                ),
              ),
              proof: createBootstrapProof(bootstrap.endpoint.httpBaseUrl),
            },
            { concurrency: 2 },
          );
      const { label, proof: bootstrapProof } = labelAndProof;

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
      const token = new TokenStore.RemoteDpopAccessToken({
        environmentId,
        accountId: identity.accountId,
        label,
        endpoint: bootstrap.endpoint,
        accessToken: access.access_token,
        expiresAtEpochMs: issuedAt + access.expires_in * 1_000,
        dpopThumbprint: thumbprint,
      });
      rememberRelayEndpoint(token, issuedAt);
      return token;
    },
  );

  const getDpopToken = Effect.fn("clientRuntime.connection.remote.getDpopToken")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpopHttp"]>[0],
  ) {
    const session = yield* cloudSession.identity;
    if (Option.isNone(session)) {
      return yield* sessionPending();
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
    const refreshSkewMs = input.refreshSkewMs ?? DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS;
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
          cached.value.expiresAtEpochMs > now + refreshSkewMs &&
          cached.value.accessToken !== input.rejectedAccessToken &&
          (owner?.accessToken !== cached.value.accessToken || owner.identity === identity)
        ) {
          tokenOwners.set(input.expectedEnvironmentId, {
            accessToken: cached.value.accessToken,
            identity,
          });
          rememberRelayEndpoint(cached.value, now);
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
    let selected = yield* getDpopToken(input);
    if (selected.fromCache) {
      const cachedSocket = yield* createDpopSocketUrl(
        selected.token,
        CACHED_ENDPOINT_SOCKET_TIMEOUT_MS,
        endpoint,
      ).pipe(Effect.result);
      if (Result.isSuccess(cachedSocket)) {
        yield* assertSession(selected.identity);
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
      yield* assertSession(selected.identity);
      selected = yield* getDpopToken({
        ...input,
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
    yield* assertSession(selected.identity);
    return authorized(selected.token, socket.success);
  });

  return RemoteEnvironmentAuthorization.of({
    authorizeBearer,
    // Untraced: it runs on every route and host check.
    rememberCheckedDescriptor: Effect.fnUntraced(function* (httpBaseUrl, descriptor) {
      if (Option.isNone(descriptor) || !httpBaseUrl.startsWith("https:")) {
        checkedDescriptors.delete(httpBaseUrl);
        return;
      }
      checkedDescriptors.set(httpBaseUrl, {
        descriptor: descriptor.value,
        at: yield* Clock.monotonicTimeNanos,
      });
    }),
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
