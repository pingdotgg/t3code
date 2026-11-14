import {
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
  type ConnectionRoute,
  PrimaryConnectionRegistration,
  RelayConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import type { RouteCheck } from "./driver.ts";
import { connectionRouteId, connectionRouteKind } from "./routes.ts";
import {
  ConnectionTransientError,
  ConnectionBlockedError,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as EnvironmentRegistry from "./registry.ts";
import {
  PullRequestRoutingPermissions,
  type StoredPullRequestRoutingPermission,
  makePullRequestRoutingPermissions,
} from "./pullRequestRoutingPermissions.ts";
import * as RpcSession from "../rpc/session.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { watchDiscoveredCompatibility } from "./layer.ts";
import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import { runDesktopCommitWithReconnectObserver } from "../state/server.ts";
import { v2ShellSnapshot } from "../state/orchestrationV2TestFixtures.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const SECOND_TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-2"),
  label: "Second environment",
  httpBaseUrl: "https://environment-2.example.test",
  wsBaseUrl: "wss://environment-2.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-relay"),
  label: "Relay environment",
});
const SECOND_RELAY_TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-relay-2"),
  label: "Second relay environment",
});

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-bearer"),
  label: "Bearer environment",
  connectionId: "bearer-connection",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: BEARER_TARGET.environmentId,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://bearer.example.test",
  wsBaseUrl: "wss://bearer.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});

const SSH_TARGET: DesktopSshEnvironmentTarget = {
  alias: "test",
  hostname: "test.example.test",
  username: "developer",
  port: 22,
};
const SSH_CONNECTION = new SshConnectionTarget({
  environmentId: EnvironmentId.make("environment-ssh"),
  label: "SSH environment",
  connectionId: "ssh-connection",
});
const SSH_PROFILE = new SshConnectionProfile({
  connectionId: SSH_CONNECTION.connectionId,
  environmentId: SSH_CONNECTION.environmentId,
  label: SSH_CONNECTION.label,
  target: SSH_TARGET,
});

const CACHED_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  ...v2ShellSnapshot,
  snapshotSequence: 1,
};

interface SessionControl {
  readonly closed: Deferred.Deferred<never, ConnectionTransientError>;
}

const makeHarness = Effect.fn("TestEnvironmentRegistry.makeHarness")(function* (
  initialTargets: ReadonlyArray<ConnectionTarget>,
  initialProfiles: ReadonlyArray<ConnectionProfile> = [],
  initialCredentials: ReadonlyArray<readonly [string, ConnectionCredential]> = [],
  options?: {
    readonly prepareError?: ConnectionBlockedError;
    readonly beforeSessionConnect?: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly beforeRegistrationRegister?: (
      registration: ConnectionRegistration,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly beforeRegistrationRemove?: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly beforeCredentialPut?: (
      connectionId: string,
    ) => Effect.Effect<void, ConnectionTransientError>;
    readonly checkRoute?: (route: ConnectionRoute) => RouteCheck;
    readonly prepareRoute?: (target: ConnectionTarget) => ConnectionBlockedError | undefined;
    readonly beforePrepareRoute?: (
      target: ConnectionTarget,
    ) => Effect.Effect<ConnectionBlockedError | undefined>;
    readonly initialDisabled?: ReadonlyArray<EnvironmentId>;
    readonly directEndpoints?: ServerConfig["directEndpoints"];
  },
) {
  const storedTargets = yield* Ref.make<ReadonlyArray<ConnectionTarget>>(initialTargets);
  const shellCache = yield* Ref.make(new Map([[TARGET.environmentId, CACHED_SNAPSHOT]]));
  const cacheClears = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
  const ownedDataClears = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
  const sessions = yield* Ref.make<ReadonlyArray<SessionControl>>([]);
  const releasedSessions = yield* Ref.make(0);
  const storedProfiles = yield* Ref.make(
    new Map(initialProfiles.map((profile) => [profile.connectionId, profile])),
  );
  const profileReadCount = yield* Ref.make(0);
  const storedCredentials = yield* Ref.make(new Map(initialCredentials));
  const storedRemoteTokens = yield* Ref.make(
    new Map([
      [
        SSH_CONNECTION.environmentId,
        new TokenStore.RemoteDpopAccessToken({
          environmentId: SSH_CONNECTION.environmentId,
          label: SSH_CONNECTION.label,
          endpoint: {
            httpBaseUrl: "https://ssh.example.test",
            wsBaseUrl: "wss://ssh.example.test",
            providerKind: "cloudflare_tunnel",
          },
          accessToken: "cached-token",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          dpopThumbprint: "thumbprint",
        }),
      ],
    ]),
  );
  const disconnectedSshTargets = yield* Ref.make<ReadonlyArray<DesktopSshEnvironmentTarget>>([]);

  const storedDisabled = yield* Ref.make<ReadonlySet<EnvironmentId>>(
    new Set(options?.initialDisabled ?? []),
  );
  const targetStore = Persistence.ConnectionTargetStore.of({
    list: Ref.get(storedTargets),
    listDisabled: Ref.get(storedDisabled).pipe(Effect.map((ids) => [...ids])),
  });
  const registrationStore = Persistence.ConnectionRegistrationStore.of({
    register: (registration, routes) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRegister?.(registration) ?? Effect.void;
        yield* Ref.update(storedTargets, (current) =>
          replaceRoutes(current, registration.target.environmentId, routes),
        );
        switch (registration._tag) {
          case "RelayConnectionRegistration":
            return;
          case "BearerConnectionRegistration":
          case "SshConnectionRegistration":
            yield* Ref.update(storedProfiles, (current) => {
              const next = new Map(current);
              next.set(registration.profile.connectionId, registration.profile);
              return next;
            });
            yield* Ref.update(storedCredentials, (current) => {
              const next = new Map(current);
              next.set(registration.target.connectionId, registration.credential);
              return next;
            });
            return;
        }
      }),
    setRoutes: (environmentId, routes) =>
      Ref.update(storedTargets, (current) => replaceRoutes(current, environmentId, routes)),
    remove: (environmentId) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRemove?.(environmentId) ?? Effect.void;
        const removed = (yield* Ref.get(storedTargets)).filter(
          (target) => target.environmentId === environmentId,
        );
        yield* Ref.update(storedTargets, (current) =>
          current.filter((target) => target.environmentId !== environmentId),
        );
        for (const target of removed) {
          if (target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget") {
            yield* Ref.update(storedProfiles, (current) => {
              const next = new Map(current);
              next.delete(target.connectionId);
              return next;
            });
            yield* Ref.update(storedCredentials, (current) => {
              const next = new Map(current);
              next.delete(target.connectionId);
              return next;
            });
          }
        }
        yield* Ref.update(storedRemoteTokens, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
      }),
    setEnabled: (environmentId, enabled) =>
      Ref.update(storedDisabled, (current) => {
        const next = new Set(current);
        if (enabled) {
          next.delete(environmentId);
        } else {
          next.add(environmentId);
        }
        return next;
      }),
  });
  const cacheStore = Persistence.EnvironmentCacheStore.of({
    loadShell: (environmentId) =>
      Ref.get(shellCache).pipe(
        Effect.map((cache) => Option.fromUndefinedOr(cache.get(environmentId))),
      ),
    saveShell: (environmentId, snapshot) =>
      Ref.update(shellCache, (current) => {
        const next = new Map(current);
        next.set(environmentId, snapshot);
        return next;
      }),
    loadThread: (_environmentId, _threadId) => Effect.succeedNone,
    saveThread: (_environmentId, _thread) => Effect.void,
    removeThread: (_environmentId, _threadId) => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: (environmentId) =>
      Ref.update(shellCache, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(cacheClears, (environmentIds) => [...environmentIds, environmentId]),
        ),
      ),
  });
  const ownedDataCleanup = Persistence.EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Ref.update(ownedDataClears, (environmentIds) => [...environmentIds, environmentId]),
  });
  const networkStatus = yield* SubscriptionRef.make<"unknown" | "offline" | "online">("online");
  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });
  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) =>
      Ref.update(profileReadCount, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(storedProfiles)),
        Effect.map((current) => Option.fromUndefinedOr(current.get(connectionId))),
      ),
    put: (profile) =>
      Ref.update(storedProfiles, (current) => {
        const next = new Map(current);
        next.set(profile.connectionId, profile);
        return next;
      }),
    remove: (connectionId) =>
      Ref.update(storedProfiles, (current) => {
        const next = new Map(current);
        next.delete(connectionId);
        return next;
      }),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) =>
      Ref.get(storedCredentials).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(connectionId))),
      ),
    put: (connectionId, credential) =>
      (options?.beforeCredentialPut?.(connectionId) ?? Effect.void).pipe(
        Effect.andThen(
          Ref.update(storedCredentials, (current) => {
            const next = new Map(current);
            next.set(connectionId, credential);
            return next;
          }),
        ),
      ),
    remove: (connectionId) =>
      Ref.update(storedCredentials, (current) => {
        const next = new Map(current);
        next.delete(connectionId);
        return next;
      }),
  });
  const tokenStore = TokenStore.RemoteDpopAccessTokenStore.of({
    get: (environmentId) =>
      Ref.get(storedRemoteTokens).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
      ),
    put: (token) =>
      Ref.update(storedRemoteTokens, (current) => {
        const next = new Map(current);
        next.set(token.environmentId, token);
        return next;
      }),
    remove: (environmentId) =>
      Ref.update(storedRemoteTokens, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }),
  });
  const sshGateway = ClientCapabilities.SshEnvironmentGateway.of({
    provision: () => Effect.die(new Error("SSH provisioning is not used.")),
    prepare: () => Effect.die(new Error("SSH preparation is not used.")),
    disconnect: (target) => Ref.update(disconnectedSshTargets, (current) => [...current, target]),
  });
  const connectedRoutes = yield* Ref.make<ReadonlyArray<string>>([]);
  const checkRoute = (route: ConnectionRoute) =>
    Effect.succeed(options?.checkRoute?.(route) ?? "unchecked");
  const connectRoute = (entry: ConnectionCatalogEntry, route: ConnectionRoute) =>
    Effect.gen(function* () {
      const target = route.target;
      const credential =
        target._tag === "BearerConnectionTarget"
          ? yield* credentialStore.get(target.connectionId)
          : Option.none();
      const prepared: PreparedConnection = {
        ...PREPARED,
        environmentId: target.environmentId,
        label: target.label,
        httpAuthorization: Option.isSome(credential)
          ? { _tag: "Bearer", token: credential.value.token }
          : null,
        target,
      };
      if (options?.prepareError) return yield* options.prepareError;
      const heldError = options?.beforePrepareRoute
        ? yield* options.beforePrepareRoute(target)
        : undefined;
      if (heldError !== undefined) return yield* heldError;
      const routeError = options?.prepareRoute?.(target);
      if (routeError !== undefined) return yield* routeError;
      yield* Ref.update(connectedRoutes, (current) => [...current, connectionRouteId(target)]);
      yield* options?.beforeSessionConnect?.(target.environmentId) ?? Effect.void;
      const closed = yield* Deferred.make<never, ConnectionTransientError>();
      yield* Ref.update(sessions, (current) => [...current, { closed }]);
      const session = yield* Effect.acquireRelease(
        Effect.succeed({
          client: {} as RpcSession.RpcSession["client"],
          initialConfig:
            options?.directEndpoints === undefined
              ? Effect.die(new Error("Config is not used by registry tests."))
              : Effect.succeed({ directEndpoints: options.directEndpoints } as ServerConfig),
          subscribeServerConfig: () =>
            options?.directEndpoints === undefined
              ? Stream.never
              : Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: { directEndpoints: options.directEndpoints } as ServerConfig,
                }),
          ready: Effect.void,
          probe: Effect.void,
          inboundFrames: Effect.succeed(0),
          closed: Deferred.await(closed),
        } satisfies RpcSession.RpcSession),
        () => Ref.update(releasedSessions, (count) => count + 1),
      );
      yield* session.ready;
      return { prepared, session };
    });
  const driver = ConnectionDriver.ConnectionDriver.of({
    connect: (entry, reportProgress) =>
      reportProgress({ stage: "preparing" }).pipe(
        Effect.andThen(
          ConnectionDriver.connectOverRoutes(entry, checkRoute, (route) =>
            connectRoute(entry, route),
          ),
        ),
      ),
    preflight: (_entry, route) =>
      checkRoute(route).pipe(
        Effect.map((check): ConnectionDriver.RoutePreflight =>
          check === "answered" ? "ready" : check,
        ),
      ),
    checkHost: () => Effect.succeed<ConnectionDriver.RouteCheck>("unchecked"),
  });

  const layerCache = Layer.succeed(Persistence.EnvironmentCacheStore, cacheStore);
  const layer = EnvironmentRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Persistence.ConnectionTargetStore, targetStore),
        Layer.succeed(Persistence.ConnectionRegistrationStore, registrationStore),
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, profileStore),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
        Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, tokenStore),
        Layer.succeed(ClientCapabilities.SshEnvironmentGateway, sshGateway),
        Layer.succeed(Connectivity.Connectivity, connectivity),
        Layer.succeed(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
        ),
        Layer.succeed(ConnectionDriver.ConnectionDriver, driver),
        layerCache,
        Layer.succeed(Persistence.EnvironmentOwnedDataCleanup, ownedDataCleanup),
      ),
    ),
  );

  return {
    layer,
    storedTargets,
    shellCache,
    cacheClears,
    ownedDataClears,
    sessions,
    releasedSessions,
    storedProfiles,
    profileReadCount,
    storedCredentials,
    storedRemoteTokens,
    storedDisabled,
    disconnectedSshTargets,
    networkStatus,
    connectedRoutes,
  };
});

function routesOf(targets: ReadonlyArray<ConnectionTarget>, environmentId: EnvironmentId) {
  return targets.filter((target) => target.environmentId === environmentId);
}

function hasRoutes(targets: ReadonlyArray<ConnectionTarget>, environmentId: EnvironmentId) {
  return routesOf(targets, environmentId).length > 0;
}

function replaceRoutes(
  current: ReadonlyArray<ConnectionTarget>,
  environmentId: EnvironmentId,
  routes: ReadonlyArray<ConnectionTarget>,
): ReadonlyArray<ConnectionTarget> {
  const firstIndex = current.findIndex((target) => target.environmentId === environmentId);
  const others = current.filter((target) => target.environmentId !== environmentId);
  const insertAt =
    firstIndex === -1
      ? others.length
      : current.slice(0, firstIndex).filter((target) => target.environmentId !== environmentId)
          .length;
  return [...others.slice(0, insertAt), ...routes, ...others.slice(insertAt)];
}

function registrySpanNames<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const names: Array<string> = [];
  const tracer = Tracer.make({
    span: (options) => {
      if (options.name.startsWith("EnvironmentRegistry.")) names.push(options.name);
      return new Tracer.NativeSpan(options);
    },
  });
  return effect.pipe(
    Effect.withTracer(tracer),
    Effect.map(() => names),
  );
}

function awaitConnectionState(
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
  predicate: (state: SupervisorConnectionState) => boolean,
) {
  return Effect.gen(function* () {
    const current = yield* registry.state(environmentId);
    if (predicate(current)) {
      return current;
    }
    return yield* registry
      .stateChanges(environmentId)
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
  });
}

describe("EnvironmentRegistry", () => {
  it.effect("protocol rejection preserves enablement through recovery and relaunch", () =>
    Effect.gen(function* () {
      const error = new ConnectionBlockedError({
        reason: "unsupported",
        detail: "Use a compatible client.",
      });
      const rejection = yield* Ref.make<ConnectionBlockedError | undefined>(error);
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        beforePrepareRoute: () => Ref.get(rejection),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* SubscriptionRef.changes(registry.entries).pipe(
          Stream.filter(
            (entries) => entries.get(RELAY_TARGET.environmentId)?.unsupportedReason !== undefined,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        expect(yield* Ref.get(harness.storedDisabled)).toEqual(new Set());
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(RELAY_TARGET.environmentId),
        ).toMatchObject({ enabled: true, unsupportedReason: error.message });
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => !state.desired && state.phase === "available",
        );
        expect(yield* Ref.get(harness.sessions)).toHaveLength(0);

        yield* Ref.set(rejection, undefined);
        yield* registry.setCompatibility(RELAY_TARGET.environmentId, null);
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        yield* registry.setCompatibility(RELAY_TARGET.environmentId, error);
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => !state.desired && state.phase === "available",
        );
        expect(yield* Ref.get(harness.releasedSessions)).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(
          RELAY_TARGET.environmentId,
        );
        expect(entry?.enabled).toBe(true);
        expect(entry?.unsupportedReason).toBeUndefined();
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
