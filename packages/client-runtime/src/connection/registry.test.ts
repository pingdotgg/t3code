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
  readonly closed: Deferred.Deferred<never, ConnectionTransientError>;
}

const makeHarness = Effect.fn("TestEnvironmentRegistry.makeHarness")(function* (
  initialTargets: ReadonlyArray<ConnectionTarget>,
  initialProfiles: ReadonlyArray<ConnectionProfile> = [],
  initialCredentials: ReadonlyArray<readonly [string, ConnectionCredential]> = [],
  options?: {
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
    new Map(initialTargets.map((target) => [target.environmentId, target])),
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
  const registrationStore = Persistence.ConnectionRegistrationStore.of({
    register: (registration) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRegister?.(registration) ?? Effect.void;
        yield* Ref.update(storedTargets, (current) => {
          const next = new Map(current);
          next.set(registration.target.environmentId, registration.target);
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
      }),
    remove: (target) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRemove?.(target) ?? Effect.void;
        yield* Ref.update(storedTargets, (current) => {
          const next = new Map(current);
          next.delete(target.environmentId);
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
        yield* Ref.update(storedRemoteTokens, (current) => {
          const next = new Map(current);
          next.delete(target.environmentId);
          return next;
        });
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
        yield* Ref.update(sessions, (current) => [...current, { closed }]);
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
        expect((yield* Ref.get(harness.storedTargets)).has(TARGET.environmentId)).toBe(false);
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

        expect((yield* Ref.get(harness.storedTargets)).get(RELAY_TARGET.environmentId)).toEqual(
          RELAY_TARGET,
        );
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer));
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
      const harness = yield* makeHarness(
        [RELAY_TARGET, SECOND_RELAY_TARGET, BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRelayEnvironments();

        const targets = yield* Ref.get(harness.storedTargets);
        expect(targets.has(RELAY_TARGET.environmentId)).toBe(false);
        expect(targets.has(SECOND_RELAY_TARGET.environmentId)).toBe(false);
        expect(targets.get(BEARER_TARGET.environmentId)).toEqual(BEARER_TARGET);
        expect(yield* Ref.get(harness.cacheClears)).toEqual(
          expect.arrayContaining([RELAY_TARGET.environmentId, SECOND_RELAY_TARGET.environmentId]),
        );
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual(
          expect.arrayContaining([RELAY_TARGET.environmentId, SECOND_RELAY_TARGET.environmentId]),
        );
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
        expect((yield* Ref.get(harness.storedTargets)).has(RELAY_TARGET.environmentId)).toBe(true);
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

        expect((yield* Ref.get(harness.storedTargets)).has(TARGET.environmentId)).toBe(false);
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
        expect((yield* Ref.get(harness.storedTargets)).has(TARGET.environmentId)).toBe(false);

        yield* registry.register(new RelayConnectionRegistration({ target: shadowedTarget }));

        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
        expect((yield* Ref.get(harness.storedTargets)).has(TARGET.environmentId)).toBe(false);
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
