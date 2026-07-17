import {
  ClientPresentation,
  CloudSession,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
  RelayDeviceIdentity,
  SshEnvironmentGateway,
} from "@t3tools/client-runtime/platform";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { managedRelayAccountChanges, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import {
  AuthStandardClientScopes,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { isHostedStaticApp } from "../hostedPairing";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import {
  desktopLocalConnectionId,
  readDesktopSecondaryBootstrapsResult,
  type DesktopSecondaryBootstrapsRead,
} from "./desktopLocal";
import { connectionStorageLayer } from "./storage";

let nextObservedRpcRequestId = 0;

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const connectivityLayer = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.merge(
    Stream.callback<"application-active">((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = () => {
            if (document.visibilityState === "visible") {
              Queue.offerUnsafe(queue, "application-active");
            }
          };
          document.addEventListener("visibilitychange", listener);
          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            document.removeEventListener("visibilitychange", listener);
          }),
      ).pipe(Effect.asVoid),
    ),
    managedRelayAccountChanges(appAtomRegistry).pipe(
      Stream.map(() => "credentials-changed" as const),
    ),
  ),
});

function clientMetadata() {
  const desktop = window.desktopBridge !== undefined;
  const platform = navigator.platform.trim();
  return {
    label: desktop ? "T3 Code Desktop" : "T3 Code Web",
    deviceType: "desktop" as const,
    ...(platform === "" ? {} : { os: platform }),
  };
}

function sshPreparationError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.toLowerCase().includes("cancel")) {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: message,
    });
  }
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not prepare the SSH environment: ${message}`,
  });
}

export const provisionDesktopSshEnvironment = Effect.fn(
  "web.connectionPlatform.ssh.provisionDesktop",
)(function* (bridge: DesktopBridge, target: DesktopSshEnvironmentTarget) {
  const bootstrap = yield* Effect.tryPromise({
    try: () =>
      bridge.ensureSshEnvironment(target, {
        issuePairingToken: true,
      }),
    catch: sshPreparationError,
  });
  const pairingToken = bootstrap.pairingToken;
  if (pairingToken === null) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The SSH environment did not issue a pairing credential.",
    });
  }
  const descriptor = yield* Effect.tryPromise({
    try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
    catch: sshPreparationError,
  });
  const access = yield* Effect.tryPromise({
    try: () => bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, pairingToken),
    catch: sshPreparationError,
  });
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    bootstrap,
    bearerToken: access.access_token,
  };
});

const capabilitiesLayer = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientPresentation.of({
      metadata: clientMetadata(),
      scopes: AuthStandardClientScopes,
    });
    const cloudSession = CloudSession.of({
      clerkToken: Effect.gen(function* () {
        const session = appAtomRegistry.get(managedRelaySessionAtom);
        if (session === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "Sign in to T3 Connect to connect this environment.",
          });
        }
        const token = yield* session.readClerkToken().pipe(
          Effect.mapError(
            (error) =>
              new ConnectionTransientError({
                reason: "network",
                detail: error.message,
              }),
          ),
        );
        if (token === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "The T3 Connect session is unavailable.",
          });
        }
        return token;
      }),
    });
    const identity = RelayDeviceIdentity.of({
      deviceId: Effect.succeed(Option.none()),
    });
    const primaryAuth = PrimaryEnvironmentAuth.of({
      bearerToken: Effect.tryPromise({
        try: readDesktopPrimaryBearerToken,
        catch: (cause) =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: `Could not load the desktop primary credential: ${String(cause)}`,
          }),
      }).pipe(Effect.map(Option.fromNullishOr)),
    });
    const ssh = SshEnvironmentGateway.of({
      provision: Effect.fn("web.connectionPlatform.ssh.provision")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        return yield* provisionDesktopSshEnvironment(bridge, target);
      }),
      prepare: Effect.fn("web.connectionPlatform.ssh.prepare")(function* (input) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        const bootstrap = yield* Effect.tryPromise({
          try: () =>
            bridge.ensureSshEnvironment(input.target, {
              issuePairingToken: true,
            }),
          catch: sshPreparationError,
        });
        if (bootstrap.pairingToken === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "The SSH environment did not issue a pairing credential.",
          });
        }
        const access = yield* Effect.tryPromise({
          try: () =>
            bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, bootstrap.pairingToken!),
          catch: sshPreparationError,
        });
        return {
          bootstrap,
          bearerToken: access.access_token,
        };
      }),
      disconnect: Effect.fn("web.connectionPlatform.ssh.disconnect")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return;
        }
        yield* Effect.tryPromise({
          try: () => bridge.disconnectSshEnvironment(target),
          catch: (cause) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: `Could not disconnect the SSH environment: ${String(cause)}`,
            }),
        });
      }),
    });

    return Context.make(CloudSession, cloudSession).pipe(
      Context.add(PrimaryEnvironmentAuth, primaryAuth),
      Context.add(RelayDeviceIdentity, identity),
      Context.add(ClientPresentation, presentation),
      Context.add(SshEnvironmentGateway, ssh),
    );
  }),
);

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)(function* (resolved: PrimaryEnvironmentTarget) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: resolved.target.httpBaseUrl,
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer), Effect.mapError(mapRemoteEnvironmentError));
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    }),
  });
});

// A desktop-local secondary backend (e.g. a parallel WSL backend) lives on its
// own loopback origin, so — unlike the same-origin primary — it authenticates
// with a bearer token minted from the bootstrap credential the desktop issues.
const loadSecondaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadSecondaryConnectionRegistration",
)(function* (entry: DesktopEnvironmentBootstrap) {
  if (
    entry.httpBaseUrl === null ||
    entry.wsBaseUrl === null ||
    entry.bootstrapToken === undefined
  ) {
    return yield* new ConnectionTransientError({
      reason: "endpoint-unavailable",
      detail: `Desktop-local backend ${entry.id} is not ready yet.`,
    });
  }
  const httpBaseUrl = entry.httpBaseUrl;
  const wsBaseUrl = entry.wsBaseUrl;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
  const issuedAtEpochMs = yield* Clock.currentTimeMillis;
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl,
    credential: entry.bootstrapToken,
    scopes: AuthStandardClientScopes,
    clientMetadata: clientMetadata(),
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  // Keep the desktop pool's stable backend id in the connection id. The
  // descriptor environment id still scopes projects and RPC state, while the
  // backend id lets desktop-only operations (notably the WSL folder picker)
  // route back to the instance that owns the environment.
  const connectionId = desktopLocalConnectionId(entry.id);
  // Prefer the desktop's bootstrap label (it identifies the backend and distro,
  // e.g. "WSL: Ubuntu") over the generic descriptor label, so consumers can show
  // a meaningful name without recovering it from the bootstrap list later.
  const label = entry.label || descriptor.label;
  return {
    registration: new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label,
        httpBaseUrl,
        wsBaseUrl,
      }),
      credential: new BearerConnectionCredential({ token: access.access_token }),
    }),
    expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, access.expires_in),
    refreshAtEpochMs: secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, access.expires_in),
  };
});

// Poll cadence for the desktop bootstrap topology. There is no change event on
// the bridge, so the renderer polls; successful registrations are cached by a
// signature of their endpoint + token until bearer credentials approach expiry.
const PLATFORM_POLL_INTERVAL = "3 seconds";
const SECONDARY_BEARER_REFRESH_SKEW_MS = 5_000;

export function secondaryBearerExpiresAtEpochMs(
  issuedAtEpochMs: number,
  expiresInSeconds: number,
): number {
  return issuedAtEpochMs + Math.max(0, expiresInSeconds * 1_000);
}

export function secondaryBearerRefreshAtEpochMs(
  issuedAtEpochMs: number,
  expiresInSeconds: number,
): number {
  return Math.max(
    issuedAtEpochMs,
    secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, expiresInSeconds) -
      SECONDARY_BEARER_REFRESH_SKEW_MS,
  );
}

interface CachedPlatformRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
  readonly expiresAtEpochMs?: number;
  readonly refreshAtEpochMs?: number;
}

export type PrimaryEnvironmentTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: PrimaryEnvironmentTarget | null;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export function readPrimaryEnvironmentTargetResult(
  readTarget: () => PrimaryEnvironmentTarget | null = readPrimaryEnvironmentTarget,
): PrimaryEnvironmentTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

export function primaryRegistrationToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: PrimaryEnvironmentTargetRead,
): CachedPlatformRegistration | undefined {
  return topologyRead._tag === "Failure" ? previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID) : undefined;
}

export function canReuseCachedPlatformRegistration(
  cached: CachedPlatformRegistration,
  signature: string,
  nowEpochMs: number,
): boolean {
  return (
    cached.signature === signature &&
    (cached.refreshAtEpochMs === undefined || nowEpochMs < cached.refreshAtEpochMs)
  );
}

export function canRetainCachedPlatformRegistrationAfterRefreshFailure(
  cached: CachedPlatformRegistration,
  signature: string,
  nowEpochMs: number,
): boolean {
  return (
    cached.signature === signature &&
    cached.expiresAtEpochMs !== undefined &&
    nowEpochMs < cached.expiresAtEpochMs
  );
}

export function secondaryRegistrationsToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: DesktopSecondaryBootstrapsRead,
  nowEpochMs: number,
): ReadonlyMap<string, CachedPlatformRegistration> {
  if (topologyRead._tag === "Success") {
    return new Map();
  }
  return new Map(
    [...previous].filter(
      ([, cached]) => cached.expiresAtEpochMs !== undefined && nowEpochMs < cached.expiresAtEpochMs,
    ),
  );
}

const platformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource,
  Effect.gen(function* () {
    if (isHostedStaticApp()) {
      return PlatformConnectionSource.of({
        registrations: Stream.empty,
      });
    }
    const cacheRef = yield* Ref.make(new Map<string, CachedPlatformRegistration>());

    // Resolve the full set of platform-managed environments the host currently
    // reports: the primary (same-origin cookie auth) plus any desktop-local
    // backends running alongside it (bearer auth). Reused registrations come
    // from the cache; a failed entry is skipped and retried on the next poll.
    const buildPlatformRegistrations = Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const nowEpochMs = yield* Clock.currentTimeMillis;
      const next = new Map<string, CachedPlatformRegistration>();
      const registrations: Array<PlatformConnectionRegistration> = [];

      const primaryTopologyRead = readPrimaryEnvironmentTargetResult();
      const retainedPrimary = primaryRegistrationToRetainAfterTopologyRead(
        previous,
        primaryTopologyRead,
      );
      if (retainedPrimary !== undefined) {
        next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, retainedPrimary);
        registrations.push(retainedPrimary.registration);
      }

      if (primaryTopologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the primary environment topology.", {
          cause: primaryTopologyRead.cause,
        });
      } else if (primaryTopologyRead.target !== null) {
        const primaryTarget = primaryTopologyRead.target;
        const signature = `primary|${primaryTarget.target.httpBaseUrl}|${primaryTarget.target.wsBaseUrl}`;
        const cached = previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
        if (
          cached !== undefined &&
          canReuseCachedPlatformRegistration(cached, signature, nowEpochMs)
        ) {
          next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cached);
          registrations.push(cached.registration);
        } else {
          const built = yield* loadPrimaryConnectionRegistration(primaryTarget).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not discover the primary environment.", { error }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, registration: built.value };
            next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cacheEntry);
            registrations.push(built.value);
          }
        }
      }

      const topologyRead = readDesktopSecondaryBootstrapsResult();
      for (const [id, cached] of secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        topologyRead,
        nowEpochMs,
      )) {
        next.set(id, cached);
        registrations.push(cached.registration);
      }

      if (topologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the desktop-local backend topology.", {
          cause: topologyRead.cause,
        });
      } else {
        for (const bootstrap of topologyRead.bootstraps) {
          const signature = `${bootstrap.httpBaseUrl}|${bootstrap.wsBaseUrl}|${bootstrap.bootstrapToken ?? ""}`;
          const cached = previous.get(bootstrap.id);
          if (
            cached !== undefined &&
            canReuseCachedPlatformRegistration(cached, signature, nowEpochMs)
          ) {
            next.set(bootstrap.id, cached);
            registrations.push(cached.registration);
            continue;
          }
          const built = yield* loadSecondaryConnectionRegistration(bootstrap).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not connect a desktop-local backend.", {
                id: bootstrap.id,
                error,
              }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, ...built.value };
            next.set(bootstrap.id, cacheEntry);
            registrations.push(built.value.registration);
          } else if (
            cached !== undefined &&
            canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, signature, nowEpochMs)
          ) {
            next.set(bootstrap.id, cached);
            registrations.push(cached.registration);
          }
        }
      }

      yield* Ref.set(cacheRef, next);
      return registrations as ReadonlyArray<PlatformConnectionRegistration>;
    }).pipe(Effect.provide(FetchHttpClient.layer));

    return PlatformConnectionSource.of({
      registrations: Stream.tick(PLATFORM_POLL_INTERVAL).pipe(
        Stream.mapEffect(() => buildPlatformRegistrations),
      ),
    });
  }),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      }),
  }),
);

const rpcRequestObserverLayer = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, method }) =>
      Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, `${method} · ${environmentId}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      }),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof connectionStorageLayer
  | typeof connectivityLayer
  | typeof wakeupsLayer
  | typeof capabilitiesLayer
  | typeof platformConnectionSourceLayer
  | typeof environmentOwnedDataCleanupLayer
  | typeof rpcRequestObserverLayer;

export const connectionPlatformLayer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  connectionStorageLayer,
  connectivityLayer,
  wakeupsLayer,
  capabilitiesLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
  rpcRequestObserverLayer,
);
