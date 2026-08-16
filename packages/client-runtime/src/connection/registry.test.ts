import {
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionRegistration,
  PrimaryConnectionRegistration,
  RelayConnectionRegistration,
  SshConnectionProfile,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  ConnectionTransientError,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  connectionTargetId,
  type ConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as RpcSession from "../rpc/session.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

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

const CACHED_SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: "2026-06-06T00:00:00.000Z",
};

interface SessionControl {
  readonly connectionId: string;
  readonly closed: Deferred.Deferred<never, ConnectionTransientError>;
}

const makeHarness = Effect.fn("TestEnvironmentRegistry.makeHarness")(function* (
  initialTargets: ReadonlyArray<ConnectionTarget>,
  initialProfiles: ReadonlyArray<ConnectionProfile> = [],
  initialCredentials: ReadonlyArray<readonly [string, ConnectionCredential]> = [],
  options?: {
    readonly retainsSiblingRoutes?: boolean;
    readonly beforeSessionConnect?: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly beforeRegistrationRegister?: (
      registration: ConnectionRegistration,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly beforeRegistrationRemove?: (
      target: ConnectionTarget,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
  },
) {
  const storedTargets = yield* Ref.make(
    new Map(initialTargets.map((target) => [connectionTargetId(target), target])),
  );
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

  const targetStore = Persistence.ConnectionTargetStore.of({
    list: Ref.get(storedTargets).pipe(Effect.map((targets) => [...targets.values()])),
  });
  const persistRegistration = (registration: ConnectionRegistration) =>
    Effect.gen(function* () {
      yield* Ref.update(storedTargets, (current) => {
        const next = new Map(current);
        next.delete(connectionTargetId(registration.target));
        next.set(connectionTargetId(registration.target), registration.target);
        return next;
      });
      switch (registration._tag) {
        case "RelayConnectionRegistration":
          return;
        case "BearerConnectionRegistration":
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
        case "SshConnectionRegistration":
          yield* Ref.update(storedProfiles, (current) => {
            const next = new Map(current);
            next.set(registration.profile.connectionId, registration.profile);
            return next;
          });
      }
    });
  const registrationStore = Persistence.ConnectionRegistrationStore.of({
    retainsSiblingRoutes: options?.retainsSiblingRoutes ?? true,
    register: (registration) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRegister?.(registration) ?? Effect.void;
        yield* persistRegistration(registration);
      }),
    update: (registration) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRegister?.(registration) ?? Effect.void;
        yield* persistRegistration(registration);
      }),
    remove: (target) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRemove?.(target) ?? Effect.void;
        yield* Ref.update(storedTargets, (current) => {
          const next = new Map(current);
          next.delete(connectionTargetId(target));
          return next;
        });
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
        const hasSiblingRoute = [...(yield* Ref.get(storedTargets)).values()].some(
          (candidate) => candidate.environmentId === target.environmentId,
        );
        if (!hasSiblingRoute) {
          yield* Ref.update(storedRemoteTokens, (current) => {
            const next = new Map(current);
            next.delete(target.environmentId);
            return next;
          });
        }
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
    loadThread: (_environmentId, _threadId) => Effect.succeed(Option.none()),
    saveThread: (_environmentId, _thread) => Effect.void,
    removeThread: (_environmentId, _threadId) => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
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
      Ref.update(storedCredentials, (current) => {
        const next = new Map(current);
        next.set(connectionId, credential);
        return next;
      }),
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
  const driver = ConnectionDriver.ConnectionDriver.of({
    connect: (entry, reportProgress) =>
      Effect.gen(function* () {
        const target = entry.target;
        const prepared = {
          ...PREPARED,
          environmentId: target.environmentId,
          label: target.label,
          target,
        };
        yield* reportProgress({ stage: "preparing" });
        yield* reportProgress({ stage: "opening", prepared });
        yield* options?.beforeSessionConnect?.(target.environmentId) ?? Effect.void;
        const closed = yield* Deferred.make<never, ConnectionTransientError>();
        yield* Ref.update(sessions, (current) => [
          ...current,
          { connectionId: connectionTargetId(target), closed },
        ]);
        const session = yield* Effect.acquireRelease(
          Effect.succeed({
            client: {} as RpcSession.RpcSession["client"],
            initialConfig: Effect.die(new Error("Config is not used by registry tests.")),
            ready: Effect.void,
            probe: Effect.void,
            closed: Deferred.await(closed),
          } satisfies RpcSession.RpcSession),
          () => Ref.update(releasedSessions, (count) => count + 1),
        );
        yield* reportProgress({ stage: "synchronizing", prepared });
        yield* session.ready;
        return { prepared, session };
      }),
  });

  const cacheLayer = Layer.succeed(Persistence.EnvironmentCacheStore, cacheStore);
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
        cacheLayer,
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
    disconnectedSshTargets,
    networkStatus,
  };
});

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

function awaitSavedConnectionState(
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  connectionId: string,
  predicate: (state: SupervisorConnectionState) => boolean,
) {
  return Effect.gen(function* () {
    const current = yield* registry.connectionState(connectionId);
    if (predicate(current)) {
      return current;
    }
    return yield* registry
      .connectionStateChanges(connectionId)
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
  });
}

describe("EnvironmentRegistry", () => {
  it.effect("hydrates connection profiles into catalog entries", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([SSH_CONNECTION], [SSH_PROFILE]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(
          SSH_CONNECTION.environmentId,
        );

        expect(entry?.target).toEqual(SSH_CONNECTION);
        expect(Option.getOrThrow(entry?.profile ?? Option.none())).toEqual(SSH_PROFILE);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("publishes network status changes independently of connection state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const offline = yield* Effect.forkChild(
          SubscriptionRef.changes(registry.networkStatus).pipe(
            Stream.filter((status) => status === "offline"),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
        );

        yield* SubscriptionRef.set(harness.networkStatus, "offline");

        expect(yield* Fiber.join(offline)).toBe("offline");
        expect(yield* SubscriptionRef.get(registry.networkStatus)).toBe("offline");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("starts persisted environments independently", () =>
    Effect.gen(function* () {
      const bothLoadsStarted = yield* Deferred.make<void>();
      const releaseLoads = yield* Deferred.make<void>();
      const loadCount = yield* Ref.make(0);
      const harness = yield* makeHarness([TARGET, SECOND_TARGET], [], [], {
        beforeSessionConnect: () =>
          Ref.updateAndGet(loadCount, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 2 ? Deferred.succeed(bothLoadsStarted, undefined) : Effect.void,
            ),
            Effect.andThen(Deferred.await(releaseLoads)),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const start = yield* Effect.forkChild(registry.start);

        yield* Deferred.await(bothLoadsStarted).pipe(Effect.timeout("1 second"));
        yield* Deferred.succeed(releaseLoads, undefined);
        yield* Fiber.join(start);

        expect(yield* Ref.get(loadCount)).toBe(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("exposes the current RPC generation to late query subscribers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const generation = yield* registry
          .runStream(
            TARGET.environmentId,
            Stream.unwrap(
              EnvironmentSupervisor.EnvironmentSupervisor.pipe(
                Effect.map((supervisor) =>
                  Stream.concat(
                    Stream.fromEffect(SubscriptionRef.get(supervisor.state)),
                    SubscriptionRef.changes(supervisor.state),
                  ).pipe(
                    Stream.filterMap((state) =>
                      state.phase === "connected"
                        ? Result.succeed(state.generation)
                        : Result.failVoid,
                    ),
                    Stream.changes,
                  ),
                ),
              ),
            ),
          )
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));

        expect(generation).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("preserves cached data on connection failure and clears it on explicit removal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        const controls = yield* Ref.get(harness.sessions);
        expect(controls).toHaveLength(1);
        const active = controls[0];
        expect(active).toBeDefined();
        expect((yield* Ref.get(harness.shellCache)).get(TARGET.environmentId)).toEqual(
          CACHED_SNAPSHOT,
        );

        const retryFiber = yield* Effect.forkChild(
          awaitConnectionState(
            registry,
            TARGET.environmentId,
            (state) => state.phase === "backoff",
          ),
        );
        yield* Effect.yieldNow;
        yield* Deferred.fail(
          active!.closed,
          new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
          }),
        );
        yield* Fiber.join(retryFiber);
        expect((yield* Ref.get(harness.shellCache)).get(TARGET.environmentId)).toEqual(
          CACHED_SNAPSHOT,
        );

        yield* registry.remove(TARGET.environmentId);
        expect((yield* Ref.get(harness.storedTargets)).has(connectionTargetId(TARGET))).toBe(false);
        expect((yield* Ref.get(harness.shellCache)).has(TARGET.environmentId)).toBe(false);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([TARGET.environmentId]);
        expect((yield* SubscriptionRef.get(registry.entries)).has(TARGET.environmentId)).toBe(
          false,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("persists and starts a newly registered environment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }));
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        expect(
          (yield* Ref.get(harness.storedTargets)).get(connectionTargetId(RELAY_TARGET)),
        ).toEqual(RELAY_TARGET);
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("updates and removes same-environment connections independently", () =>
    Effect.gen(function* () {
      const secondTarget = new BearerConnectionTarget({
        environmentId: BEARER_TARGET.environmentId,
        label: "Bearer environment on office Wi-Fi",
        connectionId: "bearer-connection-office",
      });
      const secondProfile = new BearerConnectionProfile({
        connectionId: secondTarget.connectionId,
        environmentId: secondTarget.environmentId,
        label: secondTarget.label,
        httpBaseUrl: "http://192.168.50.10:3773",
        wsBaseUrl: "ws://192.168.50.10:3773",
      });
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.register(
          new BearerConnectionRegistration({
            target: secondTarget,
            profile: secondProfile,
            credential: new BearerConnectionCredential({ token: "office-token" }),
          }),
        );
        yield* Effect.all(
          [BEARER_TARGET.connectionId, secondTarget.connectionId].map((connectionId) =>
            awaitSavedConnectionState(
              registry,
              connectionId,
              (state) => state.phase === "connected",
            ),
          ),
          { concurrency: "unbounded" },
        );

        expect([...(yield* SubscriptionRef.get(registry.connections)).keys()]).toEqual([
          BEARER_TARGET.connectionId,
          secondTarget.connectionId,
        ]);
        expect(yield* Ref.get(harness.sessions)).toHaveLength(2);
        expect([...(yield* Ref.get(harness.storedTargets)).values()]).toEqual([
          BEARER_TARGET,
          secondTarget,
        ]);

        const updatedSecondTarget = new BearerConnectionTarget({
          ...secondTarget,
          label: "Renamed office route",
        });
        yield* registry.update(
          new BearerConnectionRegistration({
            target: updatedSecondTarget,
            profile: new BearerConnectionProfile({
              ...secondProfile,
              label: updatedSecondTarget.label,
            }),
            credential: new BearerConnectionCredential({ token: "updated-office-token" }),
          }),
        );
        expect(
          (yield* SubscriptionRef.get(registry.connections)).get(secondTarget.connectionId)?.target,
        ).toEqual(updatedSecondTarget);
        expect((yield* Ref.get(harness.storedTargets)).get(secondTarget.connectionId)).toEqual(
          updatedSecondTarget,
        );

        const updatedHomeTarget = new BearerConnectionTarget({
          ...BEARER_TARGET,
          label: "Renamed home route",
        });
        yield* registry.update(
          new BearerConnectionRegistration({
            target: updatedHomeTarget,
            profile: new BearerConnectionProfile({
              ...BEARER_PROFILE,
              label: updatedHomeTarget.label,
            }),
            credential: BEARER_CREDENTIAL,
          }),
        );
        expect(
          (yield* SubscriptionRef.get(registry.connections)).get(BEARER_TARGET.connectionId)
            ?.target,
        ).toEqual(updatedHomeTarget);
        expect((yield* Ref.get(harness.storedTargets)).get(BEARER_TARGET.connectionId)).toEqual(
          updatedHomeTarget,
        );

        yield* registry.removeConnection(secondTarget.connectionId);
        expect(
          (yield* SubscriptionRef.get(registry.connections)).has(secondTarget.connectionId),
        ).toBe(false);
        expect([...(yield* Ref.get(harness.storedTargets)).values()]).toEqual([updatedHomeTarget]);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);

        yield* registry.removeConnection(BEARER_TARGET.connectionId);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).has(BEARER_TARGET.environmentId),
        ).toBe(false);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([BEARER_TARGET.environmentId]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("starts same-environment connections independently", () =>
    Effect.gen(function* () {
      const secondTarget = new BearerConnectionTarget({
        environmentId: BEARER_TARGET.environmentId,
        label: "Bearer environment on office Wi-Fi",
        connectionId: "bearer-connection-office",
      });
      const secondProfile = new BearerConnectionProfile({
        connectionId: secondTarget.connectionId,
        environmentId: secondTarget.environmentId,
        label: secondTarget.label,
        httpBaseUrl: "http://192.168.50.10:3773",
        wsBaseUrl: "ws://192.168.50.10:3773",
      });
      const harness = yield* makeHarness(
        [BEARER_TARGET, secondTarget],
        [BEARER_PROFILE, secondProfile],
        [
          [BEARER_TARGET.connectionId, BEARER_CREDENTIAL],
          [secondTarget.connectionId, new BearerConnectionCredential({ token: "office-token" })],
        ],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* Effect.all(
          [BEARER_TARGET.connectionId, secondTarget.connectionId].map((connectionId) =>
            awaitSavedConnectionState(
              registry,
              connectionId,
              (state) => state.phase === "connected",
            ),
          ),
          { concurrency: "unbounded" },
        );

        expect(yield* Ref.get(harness.sessions)).toHaveLength(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("moves a connection state stream to the supervisor created by an update", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const firstConnected = yield* Deferred.make<void>();
        const secondConnected = yield* Deferred.make<void>();
        const connectedCount = yield* Ref.make(0);
        const subscription = yield* registry
          .connectionStateChanges(BEARER_TARGET.connectionId)
          .pipe(
            Stream.filter((state) => state.phase === "connected"),
            Stream.runForEach(() =>
              Ref.updateAndGet(connectedCount, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 1
                    ? Deferred.succeed(firstConnected, undefined)
                    : Deferred.succeed(secondConnected, undefined),
                ),
              ),
            ),
            Effect.forkChild,
          );

        yield* Deferred.await(firstConnected);
        yield* registry.update(
          new BearerConnectionRegistration({
            target: new BearerConnectionTarget({
              ...BEARER_TARGET,
              label: "Updated bearer environment",
            }),
            profile: new BearerConnectionProfile({
              ...BEARER_PROFILE,
              label: "Updated bearer environment",
              httpBaseUrl: "https://updated-bearer.example.test",
              wsBaseUrl: "wss://updated-bearer.example.test",
            }),
            credential: BEARER_CREDENTIAL,
          }),
        );
        yield* Deferred.await(secondConnected);
        yield* Fiber.interrupt(subscription);

        expect(yield* Ref.get(connectedCount)).toBe(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("closes a replaced connection for single-route clients", () =>
    Effect.gen(function* () {
      const replacementTarget = new BearerConnectionTarget({
        environmentId: BEARER_TARGET.environmentId,
        label: "Replacement bearer environment",
        connectionId: "bearer-connection-replacement",
      });
      const replacementProfile = new BearerConnectionProfile({
        connectionId: replacementTarget.connectionId,
        environmentId: replacementTarget.environmentId,
        label: replacementTarget.label,
        httpBaseUrl: "http://192.168.50.10:3773",
        wsBaseUrl: "ws://192.168.50.10:3773",
      });
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
        { retainsSiblingRoutes: false },
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitSavedConnectionState(
          registry,
          BEARER_TARGET.connectionId,
          (state) => state.phase === "connected",
        );
        yield* registry.register(
          new BearerConnectionRegistration({
            target: replacementTarget,
            profile: replacementProfile,
            credential: new BearerConnectionCredential({ token: "replacement-token" }),
          }),
        );
        yield* awaitSavedConnectionState(
          registry,
          replacementTarget.connectionId,
          (state) => state.phase === "connected",
        );

        expect([...(yield* SubscriptionRef.get(registry.connections)).keys()]).toEqual([
          replacementTarget.connectionId,
        ]);
        expect(yield* Ref.get(harness.releasedSessions)).toBe(1);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(BEARER_TARGET.environmentId)?.target,
        ).toEqual(replacementTarget);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("keeps an environment connected through a healthy sibling connection", () =>
    Effect.gen(function* () {
      const secondTarget = new BearerConnectionTarget({
        environmentId: BEARER_TARGET.environmentId,
        label: "Bearer environment on office Wi-Fi",
        connectionId: "bearer-connection-office",
      });
      const secondProfile = new BearerConnectionProfile({
        connectionId: secondTarget.connectionId,
        environmentId: secondTarget.environmentId,
        label: secondTarget.label,
        httpBaseUrl: "http://192.168.50.10:3773",
        wsBaseUrl: "ws://192.168.50.10:3773",
      });
      const harness = yield* makeHarness(
        [BEARER_TARGET, secondTarget],
        [BEARER_PROFILE, secondProfile],
        [
          [BEARER_TARGET.connectionId, BEARER_CREDENTIAL],
          [secondTarget.connectionId, new BearerConnectionCredential({ token: "office-token" })],
        ],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* Effect.all(
          [BEARER_TARGET.connectionId, secondTarget.connectionId].map((connectionId) =>
            awaitSavedConnectionState(
              registry,
              connectionId,
              (state) => state.phase === "connected",
            ),
          ),
          { concurrency: "unbounded" },
        );
        const selectedTarget = (yield* SubscriptionRef.get(registry.entries)).get(
          BEARER_TARGET.environmentId,
        )?.target;
        expect(selectedTarget).toBeDefined();
        const selectedConnectionId = connectionTargetId(selectedTarget!);
        const siblingTarget =
          selectedConnectionId === BEARER_TARGET.connectionId ? secondTarget : BEARER_TARGET;
        const sessions = yield* Ref.get(harness.sessions);
        const selectedSession = sessions.find(
          (session) => session.connectionId === selectedConnectionId,
        );
        expect(selectedSession).toBeDefined();
        yield* Deferred.fail(
          selectedSession!.closed,
          new ConnectionTransientError({
            reason: "transport",
            detail: "Selected network disconnected.",
          }),
        );
        yield* awaitSavedConnectionState(
          registry,
          selectedConnectionId,
          (state) => state.phase === "backoff",
        );
        const environmentState = yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        expect(environmentState.phase).toBe("connected");
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(BEARER_TARGET.environmentId)?.target,
        ).toEqual(siblingTarget);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("retries only the requested same-environment connection", () =>
    Effect.gen(function* () {
      const secondTarget = new BearerConnectionTarget({
        environmentId: BEARER_TARGET.environmentId,
        label: "Bearer environment on office Wi-Fi",
        connectionId: "bearer-connection-office",
      });
      const secondProfile = new BearerConnectionProfile({
        connectionId: secondTarget.connectionId,
        environmentId: secondTarget.environmentId,
        label: secondTarget.label,
        httpBaseUrl: "http://192.168.50.10:3773",
        wsBaseUrl: "ws://192.168.50.10:3773",
      });
      const harness = yield* makeHarness(
        [BEARER_TARGET, secondTarget],
        [BEARER_PROFILE, secondProfile],
        [
          [BEARER_TARGET.connectionId, BEARER_CREDENTIAL],
          [secondTarget.connectionId, new BearerConnectionCredential({ token: "office-token" })],
        ],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* Effect.all(
          [BEARER_TARGET.connectionId, secondTarget.connectionId].map((connectionId) =>
            awaitSavedConnectionState(
              registry,
              connectionId,
              (state) => state.phase === "connected",
            ),
          ),
          { concurrency: "unbounded" },
        );

        yield* registry.retryConnection(secondTarget.connectionId);
        yield* awaitSavedConnectionState(
          registry,
          secondTarget.connectionId,
          (state) => state.phase === "connected" && state.generation === 2,
        );

        const sessions = yield* Ref.get(harness.sessions);
        expect(
          sessions.filter((session) => session.connectionId === BEARER_TARGET.connectionId),
        ).toHaveLength(1);
        expect(
          sessions.filter((session) => session.connectionId === secondTarget.connectionId),
        ).toHaveLength(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("leaves a connection unchanged when its durable update fails", () =>
    Effect.gen(function* () {
      const secondTarget = new BearerConnectionTarget({
        environmentId: BEARER_TARGET.environmentId,
        label: "Office route",
        connectionId: "bearer-connection-office",
      });
      const secondProfile = new BearerConnectionProfile({
        connectionId: secondTarget.connectionId,
        environmentId: secondTarget.environmentId,
        label: secondTarget.label,
        httpBaseUrl: "http://192.168.50.10:3773",
        wsBaseUrl: "ws://192.168.50.10:3773",
      });
      const officeCredential = new BearerConnectionCredential({ token: "office-token" });
      const persistenceError = new Persistence.ConnectionPersistenceError({
        operation: "register-connection",
        message: "Could not update the connection.",
      });
      const harness = yield* makeHarness(
        [secondTarget, BEARER_TARGET],
        [secondProfile, BEARER_PROFILE],
        [
          [secondTarget.connectionId, officeCredential],
          [BEARER_TARGET.connectionId, BEARER_CREDENTIAL],
        ],
        { beforeRegistrationRegister: () => Effect.fail(persistenceError) },
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const updatedTarget = new BearerConnectionTarget({
          ...secondTarget,
          label: "Renamed office route",
        });
        const error = yield* registry
          .update(
            new BearerConnectionRegistration({
              target: updatedTarget,
              profile: new BearerConnectionProfile({
                ...secondProfile,
                label: updatedTarget.label,
              }),
              credential: new BearerConnectionCredential({ token: "updated-office-token" }),
            }),
          )
          .pipe(Effect.flip);

        expect(error).toEqual(persistenceError);
        expect((yield* Ref.get(harness.storedTargets)).get(secondTarget.connectionId)).toEqual(
          secondTarget,
        );
        expect((yield* Ref.get(harness.storedProfiles)).get(secondTarget.connectionId)).toEqual(
          secondProfile,
        );
        expect((yield* Ref.get(harness.storedCredentials)).get(secondTarget.connectionId)).toEqual(
          officeCredential,
        );
        expect(
          (yield* SubscriptionRef.get(registry.connections)).get(secondTarget.connectionId)?.target,
        ).toEqual(secondTarget);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(BEARER_TARGET.environmentId)?.target,
        ).toEqual(BEARER_TARGET);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("leaves a connection installed when durable removal fails", () =>
    Effect.gen(function* () {
      const secondTarget = new BearerConnectionTarget({
        environmentId: BEARER_TARGET.environmentId,
        label: "Office route",
        connectionId: "bearer-connection-office",
      });
      const secondProfile = new BearerConnectionProfile({
        connectionId: secondTarget.connectionId,
        environmentId: secondTarget.environmentId,
        label: secondTarget.label,
        httpBaseUrl: "http://192.168.50.10:3773",
        wsBaseUrl: "ws://192.168.50.10:3773",
      });
      const persistenceError = new Persistence.ConnectionPersistenceError({
        operation: "remove-connection",
        message: "Could not remove the connection.",
      });
      const harness = yield* makeHarness(
        [secondTarget, BEARER_TARGET],
        [secondProfile, BEARER_PROFILE],
        [
          [secondTarget.connectionId, new BearerConnectionCredential({ token: "office-token" })],
          [BEARER_TARGET.connectionId, BEARER_CREDENTIAL],
        ],
        { beforeRegistrationRemove: () => Effect.fail(persistenceError) },
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const error = yield* registry
          .removeConnection(BEARER_TARGET.connectionId)
          .pipe(Effect.flip);

        expect(error).toEqual(persistenceError);
        expect([...(yield* Ref.get(harness.storedTargets)).values()]).toEqual([
          secondTarget,
          BEARER_TARGET,
        ]);
        expect([...(yield* SubscriptionRef.get(registry.connections)).keys()]).toEqual([
          secondTarget.connectionId,
          BEARER_TARGET.connectionId,
        ]);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(BEARER_TARGET.environmentId)?.target,
        ).toEqual(BEARER_TARGET);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("deduplicates concurrent bearer registrations for the same address", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);
      const registrations = ["first", "second"].map((suffix) => {
        const target = new BearerConnectionTarget({
          environmentId: BEARER_TARGET.environmentId,
          label: `Bearer route ${suffix}`,
          connectionId: `bearer-connection-${suffix}`,
        });
        return new BearerConnectionRegistration({
          target,
          profile: new BearerConnectionProfile({
            connectionId: target.connectionId,
            environmentId: target.environmentId,
            label: target.label,
            httpBaseUrl: BEARER_PROFILE.httpBaseUrl,
            wsBaseUrl: BEARER_PROFILE.wsBaseUrl,
          }),
          credential: new BearerConnectionCredential({ token: `${suffix}-token` }),
        });
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* Effect.forEach(registrations, registry.register, {
          concurrency: "unbounded",
          discard: true,
        });

        expect(yield* SubscriptionRef.get(registry.connections)).toHaveLength(1);
        expect(yield* Ref.get(harness.storedTargets)).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("preserves concurrent registrations for different environments", () =>
    Effect.gen(function* () {
      const bothRegistrationsStarted = yield* Deferred.make<void>();
      const startedCount = yield* Ref.make(0);
      const targets = ["first", "second"].map(
        (suffix) =>
          new BearerConnectionTarget({
            environmentId: EnvironmentId.make(`environment-${suffix}`),
            label: `${suffix} environment`,
            connectionId: `connection-${suffix}`,
          }),
      );
      const harness = yield* makeHarness([], [], [], {
        beforeRegistrationRegister: () =>
          Ref.updateAndGet(startedCount, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 2 ? Deferred.succeed(bothRegistrationsStarted, undefined) : Effect.void,
            ),
            Effect.andThen(Deferred.await(bothRegistrationsStarted)),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* Effect.forEach(
          targets,
          (target) =>
            registry.register(
              new BearerConnectionRegistration({
                target,
                profile: new BearerConnectionProfile({
                  connectionId: target.connectionId,
                  environmentId: target.environmentId,
                  label: target.label,
                  httpBaseUrl: `http://${target.connectionId}.example.test:3773`,
                  wsBaseUrl: `ws://${target.connectionId}.example.test:3773`,
                }),
                credential: new BearerConnectionCredential({
                  token: `${target.connectionId}-token`,
                }),
              }),
            ),
          { concurrency: "unbounded", discard: true },
        );

        expect([...(yield* SubscriptionRef.get(registry.connections)).keys()].toSorted()).toEqual(
          targets.map((target) => target.connectionId).toSorted(),
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("removes every route without connecting to an intermediate failover", () =>
    Effect.gen(function* () {
      const secondTarget = new BearerConnectionTarget({
        environmentId: BEARER_TARGET.environmentId,
        label: "Second bearer route",
        connectionId: "bearer-connection-second",
      });
      const secondProfile = new BearerConnectionProfile({
        connectionId: secondTarget.connectionId,
        environmentId: secondTarget.environmentId,
        label: secondTarget.label,
        httpBaseUrl: "http://192.168.50.10:3773",
        wsBaseUrl: "ws://192.168.50.10:3773",
      });
      const harness = yield* makeHarness(
        [BEARER_TARGET, secondTarget],
        [BEARER_PROFILE, secondProfile],
        [
          [BEARER_TARGET.connectionId, BEARER_CREDENTIAL],
          [secondTarget.connectionId, new BearerConnectionCredential({ token: "second-token" })],
        ],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const sessionsBeforeRemoval = (yield* Ref.get(harness.sessions)).length;

        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
            Reflect.deleteProperty(Array.prototype, "toSorted");
            return descriptor;
          }),
          () => registry.remove(BEARER_TARGET.environmentId),
          (descriptor) =>
            Effect.sync(() => {
              if (descriptor !== undefined) {
                Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
              }
            }),
        );

        expect(yield* Ref.get(harness.sessions)).toHaveLength(sessionsBeforeRemoval);
        expect((yield* Ref.get(harness.storedTargets)).size).toBe(0);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([BEARER_TARGET.environmentId]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("moves durable streams to a replacement supervisor", () =>
    Effect.gen(function* () {
      const replacement = new RelayConnectionTarget({
        environmentId: RELAY_TARGET.environmentId,
        label: "Replacement relay environment",
      });
      const harness = yield* makeHarness([RELAY_TARGET]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const firstObserved = yield* Deferred.make<void>();
        const secondObserved = yield* Deferred.make<void>();
        const labels = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const subscription = yield* Effect.forkChild(
          registry
            .followStream(
              RELAY_TARGET.environmentId,
              Stream.unwrap(
                EnvironmentSupervisor.EnvironmentSupervisor.pipe(
                  Effect.map((supervisor) =>
                    Stream.concat(Stream.succeed(supervisor.target.label), Stream.never),
                  ),
                ),
              ),
            )
            .pipe(
              Stream.tap((label) =>
                Ref.updateAndGet(labels, (current) => [...current, label]).pipe(
                  Effect.flatMap((current) =>
                    current.length === 1
                      ? Deferred.succeed(firstObserved, undefined)
                      : Deferred.succeed(secondObserved, undefined),
                  ),
                ),
              ),
              Stream.runDrain,
            ),
        );

        yield* Deferred.await(firstObserved).pipe(Effect.timeout("1 second"));
        yield* registry.register(new RelayConnectionRegistration({ target: replacement }));
        yield* Deferred.await(secondObserved).pipe(Effect.timeout("1 second"));
        yield* Fiber.interrupt(subscription);

        expect(yield* Ref.get(labels)).toEqual([RELAY_TARGET.label, replacement.label]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("ignores retry signals for environments that are no longer registered", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.retryNow(EnvironmentId.make("removed-environment"));
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("removes all relay-owned data without touching non-cloud connections", () =>
    Effect.gen(function* () {
      const siblingRelayTarget = new RelayConnectionTarget({
        environmentId: BEARER_TARGET.environmentId,
        label: "Bearer environment through T3 Connect",
      });
      const harness = yield* makeHarness(
        [RELAY_TARGET, SECOND_RELAY_TARGET, siblingRelayTarget, BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRelayEnvironments();

        const targets = yield* Ref.get(harness.storedTargets);
        expect(targets.has(connectionTargetId(RELAY_TARGET))).toBe(false);
        expect(targets.has(connectionTargetId(SECOND_RELAY_TARGET))).toBe(false);
        expect(targets.has(connectionTargetId(siblingRelayTarget))).toBe(false);
        expect(targets.get(connectionTargetId(BEARER_TARGET))).toEqual(BEARER_TARGET);
        expect(yield* Ref.get(harness.cacheClears)).toEqual(
          expect.arrayContaining([RELAY_TARGET.environmentId, SECOND_RELAY_TARGET.environmentId]),
        );
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual(
          expect.arrayContaining([RELAY_TARGET.environmentId, SECOND_RELAY_TARGET.environmentId]),
        );
        expect(yield* Ref.get(harness.cacheClears)).not.toContain(BEARER_TARGET.environmentId);
        expect(yield* Ref.get(harness.ownedDataClears)).not.toContain(BEARER_TARGET.environmentId);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).has(BEARER_TARGET.environmentId),
        ).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("keeps the runtime registered when durable removal fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        beforeRegistrationRemove: () =>
          Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "remove-connection",
              message: "Storage is unavailable.",
            }),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const error = yield* Effect.flip(registry.removeRelayEnvironments());

        expect(error._tag).toBe("ConnectionPersistenceError");
        expect(yield* Ref.get(harness.releasedSessions)).toBe(0);
        expect((yield* SubscriptionRef.get(registry.entries)).has(RELAY_TARGET.environmentId)).toBe(
          true,
        );
        expect((yield* Ref.get(harness.storedTargets)).has(connectionTargetId(RELAY_TARGET))).toBe(
          true,
        );
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("starts a newly paired bearer environment without re-reading its profile", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(
          new BearerConnectionRegistration({
            target: BEARER_TARGET,
            profile: BEARER_PROFILE,
            credential: BEARER_CREDENTIAL,
          }),
        );
        yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        expect(yield* Ref.get(harness.profileReadCount)).toBe(0);
        expect(
          Option.getOrThrow(
            (yield* SubscriptionRef.get(registry.entries)).get(BEARER_TARGET.environmentId)
              ?.profile ?? Option.none(),
          ),
        ).toEqual(BEARER_PROFILE);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("starts platform environments without persisting or removing them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.registerPlatform(new PrimaryConnectionRegistration({ target: TARGET }));
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        expect((yield* Ref.get(harness.storedTargets)).has(connectionTargetId(TARGET))).toBe(false);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);

        const error = yield* Effect.flip(registry.remove(TARGET.environmentId));
        expect(error._tag).toBe("PlatformEnvironmentRemovalError");
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("gives a primary platform registration precedence over persisted registrations", () =>
    Effect.gen(function* () {
      const shadowedTarget = new RelayConnectionTarget({
        environmentId: TARGET.environmentId,
        label: "Shadowed relay environment",
      });
      const harness = yield* makeHarness([shadowedTarget]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.registerPlatform(new PrimaryConnectionRegistration({ target: TARGET }));

        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
        expect((yield* Ref.get(harness.storedTargets)).has(connectionTargetId(TARGET))).toBe(false);

        yield* registry.register(new RelayConnectionRegistration({ target: shadowedTarget }));

        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
        expect((yield* Ref.get(harness.storedTargets)).has(connectionTargetId(TARGET))).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("rechecks platform ownership after waiting for the environment lease", () =>
    Effect.gen(function* () {
      const registrationStarted = yield* Deferred.make<void>();
      const continueRegistration = yield* Deferred.make<void>();
      const shadowedTarget = new RelayConnectionTarget({
        environmentId: TARGET.environmentId,
        label: "Shadowed relay environment",
      });
      const harness = yield* makeHarness([], [], [], {
        beforeRegistrationRegister: () =>
          Deferred.succeed(registrationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(continueRegistration)),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const persistedRegistration = yield* registry
          .register(new RelayConnectionRegistration({ target: shadowedTarget }))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(registrationStarted);

        const platformRegistration = yield* registry
          .registerPlatform(new PrimaryConnectionRegistration({ target: TARGET }))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        const removal = yield* Effect.flip(registry.remove(TARGET.environmentId)).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Deferred.succeed(continueRegistration, undefined);
        yield* Fiber.join(persistedRegistration);
        yield* Fiber.join(platformRegistration);
        const error = yield* Fiber.join(removal);

        expect(error._tag).toBe("PlatformEnvironmentRemovalError");
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("does not reacquire a runtime while its registration is being removed", () =>
    Effect.gen(function* () {
      const removalStarted = yield* Deferred.make<void>();
      const continueRemoval = yield* Deferred.make<void>();
      const harness = yield* makeHarness([TARGET], [], [], {
        beforeRegistrationRemove: () =>
          Deferred.succeed(removalStarted, undefined).pipe(
            Effect.andThen(Deferred.await(continueRemoval)),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const removal = yield* Effect.forkChild(registry.remove(TARGET.environmentId));
        yield* Deferred.await(removalStarted);

        const stateLookup = yield* Effect.forkChild(
          Effect.flip(registry.state(TARGET.environmentId)),
        );
        yield* Effect.yieldNow;
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);

        yield* Deferred.succeed(continueRemoval, undefined);
        yield* Fiber.join(removal);
        const error = yield* Fiber.join(stateLookup);
        expect(error._tag).toBe("EnvironmentNotRegisteredError");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("does not resurrect a connection when an update loses a removal race", () =>
    Effect.gen(function* () {
      const removalStarted = yield* Deferred.make<void>();
      const continueRemoval = yield* Deferred.make<void>();
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
        {
          beforeRegistrationRemove: () =>
            Deferred.succeed(removalStarted, undefined).pipe(
              Effect.andThen(Deferred.await(continueRemoval)),
            ),
        },
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const removal = yield* Effect.forkChild(
          registry.removeConnection(BEARER_TARGET.connectionId),
        );
        yield* Deferred.await(removalStarted);

        const update = yield* Effect.flip(
          registry.update(
            new BearerConnectionRegistration({
              target: new BearerConnectionTarget({
                ...BEARER_TARGET,
                label: "Updated after removal",
              }),
              profile: new BearerConnectionProfile({
                ...BEARER_PROFILE,
                label: "Updated after removal",
              }),
              credential: BEARER_CREDENTIAL,
            }),
          ),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(continueRemoval, undefined);
        yield* Fiber.join(removal);
        const error = yield* Fiber.join(update);

        expect(error._tag).toBe("ConnectionNotRegisteredError");
        expect((yield* SubscriptionRef.get(registry.connections)).size).toBe(0);
        expect((yield* Ref.get(harness.storedTargets)).size).toBe(0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("retains a healthy runtime when the platform repeats an identical registration", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const registration = new PrimaryConnectionRegistration({ target: TARGET });
        yield* registry.registerPlatform(registration);
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        yield* registry.registerPlatform(registration);

        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("removes all owned SSH state only on explicit removal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [SSH_CONNECTION],
        [SSH_PROFILE],
        [
          [
            SSH_CONNECTION.connectionId,
            new BearerConnectionCredential({ token: "temporary-token" }),
          ],
        ],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.remove(SSH_CONNECTION.environmentId);

        expect((yield* Ref.get(harness.storedProfiles)).has(SSH_CONNECTION.connectionId)).toBe(
          false,
        );
        expect((yield* Ref.get(harness.storedCredentials)).has(SSH_CONNECTION.connectionId)).toBe(
          false,
        );
        expect((yield* Ref.get(harness.storedRemoteTokens)).has(SSH_CONNECTION.environmentId)).toBe(
          false,
        );
        expect(yield* Ref.get(harness.disconnectedSshTargets)).toEqual([SSH_TARGET]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
