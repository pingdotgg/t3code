import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import {
  exchangeRemoteDpopAccessToken,
  type RemoteEnvironmentAuthError,
  resolveRemoteDpopWebSocketConnectionUrl,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";
import { environmentMismatchError, mapRemoteEnvironmentError } from "../connection/errors.ts";
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";

import type { PreparedHttpAuthorization } from "../connection/model.ts";

export interface RelayEnvironmentAuthorization {
  readonly environmentId: EnvironmentId;
  readonly endpoint: RelayManagedEndpoint;
  readonly credential: string;
}

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
}

/** An alternative direct route to the same environment, tried before the
 * stored relay endpoint when a cached DPoP access token is available. The
 * access token is not bound to a host, so it works against any origin of the
 * same server; only the per-request DPoP proof is URL-bound and is minted
 * fresh for whichever endpoint is used. */
export interface AuthorizedEndpointOverride {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpop: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly obtainBootstrap: Effect.Effect<
        RelayEnvironmentAuthorization,
        ConnectionAttemptError
      >;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpopDirect: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly endpoint: AuthorizedEndpointOverride;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;
const CACHED_ENDPOINT_SOCKET_TIMEOUT_MS = 3_000;
const BEARER_DESCRIPTOR_CACHE_TTL_MS = 10_000;

function mapDpopSocketError(error: RemoteEnvironmentAuthError | ConnectionAttemptError) {
  return error._tag === "ConnectionTransientError" || error._tag === "ConnectionBlockedError"
    ? error
    : mapRemoteEnvironmentError(error);
}

const fetchDescriptor = Effect.fn("clientRuntime.connection.remote.fetchDescriptor")(function* (
  httpBaseUrl: string,
) {
  return yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
});

export const make = Effect.gen(function* () {
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const tokenStore = yield* TokenStore.RemoteDpopAccessTokenStore;
  const httpClient = yield* HttpClient.HttpClient;
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
    }) {
      const now = yield* Clock.currentTimeMillis;
      const cachedDescriptor = (yield* Ref.get(bearerDescriptors)).get(input.expectedEnvironmentId);
      const canReuseDescriptor =
        cachedDescriptor?.httpBaseUrl === input.httpBaseUrl &&
        cachedDescriptor.validatedAtEpochMs + BEARER_DESCRIPTOR_CACHE_TTL_MS > now;
      const descriptor = canReuseDescriptor
        ? cachedDescriptor.descriptor
        : yield* fetchDescriptor(input.httpBaseUrl).pipe(
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
    function* (
      token: TokenStore.RemoteDpopAccessToken,
      timeoutMs?: number,
      // The cached token works against any origin of the same server, so a
      // direct (LAN/Tailscale) endpoint can be substituted for the stored
      // relay endpoint when minting the websocket ticket.
      endpoint?: AuthorizedEndpointOverride,
    ) {
      const httpBaseUrl = endpoint?.httpBaseUrl ?? token.endpoint.httpBaseUrl;
      const wsBaseUrl = endpoint?.wsBaseUrl ?? token.endpoint.wsBaseUrl;
      const ticketProof = yield* signer
        .createProof({
          method: "POST",
          url: environmentEndpointUrl(httpBaseUrl, "/api/auth/websocket-ticket"),
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
        wsBaseUrl,
        httpBaseUrl,
        accessToken: token.accessToken,
        dpopProof: ticketProof,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    },
  );

  const authorizeDpop = Effect.fn("clientRuntime.connection.remote.authorizeDpop")(
    function* (input: {
      readonly expectedEnvironmentId: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeDpop"]
      >[0]["expectedEnvironmentId"];
      readonly obtainBootstrap: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeDpop"]
      >[0]["obtainBootstrap"];
    }) {
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
      const now = yield* Clock.currentTimeMillis;
      const cached = yield* tokenStore
        .get(input.expectedEnvironmentId)
        .pipe(Effect.withSpan("environment.authorization.accessToken.cache"));
      if (
        Option.isSome(cached) &&
        cached.value.environmentId === input.expectedEnvironmentId &&
        cached.value.dpopThumbprint === thumbprint &&
        cached.value.expiresAtEpochMs > now + TOKEN_EXPIRY_SAFETY_MARGIN_MS
      ) {
        yield* Effect.annotateCurrentSpan({
          "connection.remote_token_cache": "hit",
        });
        const cachedSocket = yield* createDpopSocketUrl(
          cached.value,
          CACHED_ENDPOINT_SOCKET_TIMEOUT_MS,
        ).pipe(Effect.result);
        if (Result.isSuccess(cachedSocket)) {
          return {
            environmentId: cached.value.environmentId,
            label: cached.value.label,
            httpBaseUrl: cached.value.endpoint.httpBaseUrl,
            socketUrl: cachedSocket.success,
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: cached.value.accessToken,
            },
          };
        }
        if (cachedSocket.failure._tag === "ConnectionBlockedError") {
          return yield* mapDpopSocketError(cachedSocket.failure);
        }
        yield* tokenStore
          .remove(input.expectedEnvironmentId)
          .pipe(Effect.withSpan("environment.authorization.accessToken.remove"));
      }

      yield* Effect.annotateCurrentSpan({
        "connection.remote_token_cache": "miss",
      });
      const bootstrap = yield* input.obtainBootstrap;
      const descriptor = yield* fetchDescriptor(bootstrap.endpoint.httpBaseUrl).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.descriptor"),
      );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
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
      const access = yield* exchangeRemoteDpopAccessToken({
        httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
        credential: bootstrap.credential,
        dpopProof: bootstrapProof,
        scopes: presentation.scopes,
        clientMetadata: presentation.metadata,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.accessToken.exchange"),
      );
      const issuedAt = yield* Clock.currentTimeMillis;
      const token = new TokenStore.RemoteDpopAccessToken({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        endpoint: bootstrap.endpoint,
        accessToken: access.access_token,
        expiresAtEpochMs: issuedAt + access.expires_in * 1_000,
        dpopThumbprint: thumbprint,
      });
      const socketUrl = yield* createDpopSocketUrl(token).pipe(Effect.mapError(mapDpopSocketError));
      yield* tokenStore
        .put(token)
        .pipe(Effect.withSpan("environment.authorization.accessToken.persist"));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
        socketUrl,
        httpAuthorization: {
          _tag: "Dpop" as const,
          accessToken: token.accessToken,
        },
      };
    },
  );

  // Connects through a direct route using the cached DPoP access token. There
  // is deliberately no bootstrap fallback here: bootstrap credentials are
  // single-use relay grants, so when no valid cached token exists the caller
  // must connect through the relay path instead.
  const authorizeDpopDirect = Effect.fn("clientRuntime.connection.remote.authorizeDpopDirect")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly endpoint: AuthorizedEndpointOverride;
    }) {
      const thumbprint = yield* signer.thumbprint.pipe(
        Effect.mapError(
          () =>
            new ConnectionBlockedError({
              reason: "configuration",
              detail: "Could not load the environment authorization key.",
            }),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      const cached = yield* tokenStore.get(input.expectedEnvironmentId);
      if (
        Option.isNone(cached) ||
        cached.value.dpopThumbprint !== thumbprint ||
        cached.value.expiresAtEpochMs <= now + TOKEN_EXPIRY_SAFETY_MARGIN_MS
      ) {
        return yield* new ConnectionTransientError({
          reason: "endpoint-unavailable",
          detail: "No cached environment credential is available for the direct route.",
        });
      }
      // The descriptor check keeps us from talking to an unrelated server that
      // answers on the direct address.
      const descriptor = yield* fetchDescriptor(input.endpoint.httpBaseUrl).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      const socketUrl = yield* createDpopSocketUrl(
        cached.value,
        CACHED_ENDPOINT_SOCKET_TIMEOUT_MS,
        input.endpoint,
      ).pipe(Effect.mapError(mapDpopSocketError));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.endpoint.httpBaseUrl,
        socketUrl,
        httpAuthorization: {
          _tag: "Dpop" as const,
          accessToken: cached.value.accessToken,
        },
      };
    },
  );

  return RemoteEnvironmentAuthorization.of({
    authorizeBearer,
    authorizeDpop: (input) =>
      authorizeDpop(input).pipe(Effect.withSpan("environment.authorization")),
    authorizeDpopDirect: (input) =>
      authorizeDpopDirect(input).pipe(Effect.withSpan("environment.authorization.direct")),
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
