import {
  EnvironmentId,
  ProviderDriverKind,
  ServerSelfUpdateError,
  ProviderInstanceId,
  type ProviderInstallState,
  type ProviderSetupInput,
  ServerObservability,
  EnvironmentThemeId,
  UsageLimitSourceId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  applyServerWelcomeEvent,
  createServerEnvironmentAtoms,
  serverUpdateStateAtom,
  makeEnvironmentServerWelcomeState,
  makeEnvironmentServerConfigState,
  isLegacyUpdateHandoffLoss,
  recordFetchedWorkspaceSnapshot,
  withFetchedWorkspaceSnapshots,
  matchesServerUpdateReadyEvent,
  matchesServerUpdateResumeEvent,
  nudgeReconnectDuringUpdateRestart,
  resolveServerConfigValue,
  resolveServerWelcomeState,
  resolveServerUpdateProgressResult,
  serverUpdateStateForProgressEvent,
  serverUpdateStateForServerVersion,
  validateServerUpdateReadyEvent,
  waitForNextEnvironmentReconnect,
  waitForDesktopUpdateTarget,
  runDesktopCommitWithReconnectObserver,
} from "./server.ts";
import { applyServerConfigProjection } from "./serverConfigProjection.ts";
import { CONFIG, TARGET, makeConfigPersistenceHarness, session, snapshotEvent } from "./server.helpers2.testkit.ts";

describe("server state projection", () => {

  it.effect("checks the authoritative session before accepting a buffered welcome", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<{
        readonly type: "welcome" | "ready";
        readonly payload: unknown;
      }>();
      const firstSubscribed = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromQueue(firstEvents)),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session({} as WsRpcProtocolClient);
      const supervisorSession = yield* SubscriptionRef.make(Option.some(firstSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: supervisorSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const staleWelcome = {
        environment: {} as ServerLifecycleWelcomePayload["environment"],
        cwd: "/stale",
        projectName: "stale",
      } as ServerLifecycleWelcomePayload;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerWelcomeState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          yield* Deferred.await(firstSubscribed);

          supervisorSession.value = Option.some(secondSession);
          const handled = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter(
              (value) => value.currentSession === secondSession || value.welcome === staleWelcome,
            ),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.forkChild,
          );
          yield* Queue.offer(firstEvents, { type: "welcome", payload: staleWelcome });

          const next = yield* Fiber.join(handled);
          expect(next.currentSession).toBe(secondSession);
          expect(resolveServerWelcomeState(next)).toBeNull();
        }),
      );
    }),
  );

  it.effect("reads the authoritative session after waiting for the welcome state lock", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(Stream.drain),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () => Stream.never,
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const thirdSession = session({} as WsRpcProtocolClient);
      const supervisorSession = yield* SubscriptionRef.make(Option.some(firstSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: supervisorSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerWelcomeState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          yield* Deferred.await(firstSubscribed);
          const changed = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) => value.currentSession !== firstSession),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.forkChild,
          );

          yield* state.semaphore.withPermit(
            Effect.gen(function* () {
              yield* SubscriptionRef.set(supervisorSession, Option.some(secondSession));
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              supervisorSession.value = Option.some(thirdSession);
            }),
          );

          expect((yield* Fiber.join(changed)).currentSession).toBe(thirdSession);
        }),
      );
    }),
  );

  it.effect("clears a welcome until the reconnected session sends its own", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<{
        readonly type: "welcome" | "ready";
        readonly payload: unknown;
      }>();
      const secondEvents = yield* Queue.unbounded<{
        readonly type: "welcome" | "ready";
        readonly payload: unknown;
      }>();
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const supervisorSession = yield* SubscriptionRef.make(Option.some(firstSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: supervisorSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const firstWelcome = {
        environment: {} as ServerLifecycleWelcomePayload["environment"],
        cwd: "/first",
        projectName: "first",
      } as ServerLifecycleWelcomePayload;
      const secondWelcome = {
        environment: {} as ServerLifecycleWelcomePayload["environment"],
        cwd: "/second",
        projectName: "second",
      } as ServerLifecycleWelcomePayload;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerWelcomeState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          const nextResolved = (
            predicate: (value: ServerLifecycleWelcomePayload | null) => boolean,
          ) =>
            SubscriptionRef.changes(state).pipe(
              Stream.map(resolveServerWelcomeState),
              Stream.filter(predicate),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );

          const first = yield* nextResolved((value) => value === firstWelcome).pipe(
            Effect.forkChild,
          );
          yield* Queue.offer(firstEvents, { type: "welcome", payload: firstWelcome });
          expect(yield* Fiber.join(first)).toBe(firstWelcome);

          const cleared = yield* nextResolved((value) => value === null).pipe(Effect.forkChild);
          yield* SubscriptionRef.set(supervisorSession, Option.some(secondSession));
          expect(yield* Fiber.join(cleared)).toBeNull();
          expect(resolveServerWelcomeState(yield* SubscriptionRef.get(state))).toBeNull();

          const second = yield* nextResolved((value) => value === secondWelcome).pipe(
            Effect.forkChild,
          );
          yield* Queue.offer(secondEvents, { type: "welcome", payload: secondWelcome });
          expect(yield* Fiber.join(second)).toBe(secondWelcome);
        }),
      );
    }),
  );

  it("prefers an active session config over cache until a live event arrives", () => {
    const config = (source: string, serverVersion: string) =>
      ({
        ...CONFIG,
        environment: { serverVersion },
        settings: { source },
      }) as unknown as ServerConfig;
    const cached = config("cache", "0.0.29");
    const staleLive = config("stale-live", "0.0.29");
    const initial = config("session", "0.0.30");
    const live = config("live", "0.0.30");

    expect(
      resolveServerConfigValue(
        {
          config: cached,
          latestEvent: snapshotEvent(cached),
          source: "cache",
        },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        {
          config: staleLive,
          latestEvent: snapshotEvent(staleLive),
          source: "live",
        },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        {
          config: live,
          latestEvent: snapshotEvent(live),
          source: "live",
        },
        initial,
      ),
    ).toBe(live);
  });

  it("merges fetched workspace snapshots only from servers that omit them", () => {
    const claude = ProviderInstanceId.make("claudeAgent");
    const codex = ProviderInstanceId.make("codex");
    const snapshot = (cwd: string, command: string) => ({
      cwd,
      checkedAt: "2026-10-25T00:00:00.000Z",
      slashCommands: [{ name: command }],
      skills: [],
    });
    const provider = (
      instanceId: ProviderInstanceId,
      workspaceSnapshots?: ReadonlyArray<ReturnType<typeof snapshot>>,
      slashCommands: ReadonlyArray<{ readonly name: string }> = [],
    ) =>
      ({
        instanceId,
        enabled: true,
        slashCommands,
        skills: [],
        ...(workspaceSnapshots ? { workspaceSnapshots } : {}),
      }) as unknown as ServerConfig["providers"][number];
    const configWith = (onDemand: boolean, providers: ServerConfig["providers"]) =>
      ({
        ...CONFIG,
        environment: { capabilities: { providerWorkspaceSnapshotsOnDemand: onDemand } },
        providers,
      }) as unknown as ServerConfig;
    const claudeA = snapshot("/a", "claude");
    const record = (
      current: Parameters<typeof recordFetchedWorkspaceSnapshot>[0],
      instanceId: ProviderInstanceId,
      fresh: boolean,
      reply: ServerConfig["providers"],
    ) =>
      recordFetchedWorkspaceSnapshot(
        current,
        { instanceId, cwd: "/a", fresh },
        reply,
        provider(instanceId),
      );

    let fetched = record([], claude, false, [provider(claude, [claudeA])]);
    fetched = record(fetched, codex, false, [provider(codex, [snapshot("/a", "codex")])]);
    const merged = withFetchedWorkspaceSnapshots(
      configWith(true, [provider(claude), provider(codex)]),
      fetched,
    );
    expect(merged.providers[0]?.workspaceSnapshots).toEqual([claudeA]);
    // An unchanged answer keeps the cache, so config readers do not re-render.
    expect(
      record(fetched, claude, false, [
        provider(claude, [JSON.parse(JSON.stringify(claudeA)) as typeof claudeA]),
      ]),
    ).toBe(fetched);

    // Health checks and usage updates leave the snapshot in place.
    expect(
      withFetchedWorkspaceSnapshots(
        configWith(true, [
          { ...provider(claude), checkedAt: "2026-10-25T00:09:00.000Z", usageLimits: {} },
        ] as unknown as ServerConfig["providers"]),
        fetched,
      ).providers[0]?.workspaceSnapshots,
    ).toEqual([claudeA]);

    // New provider-wide commands, such as a live session's, retire the old snapshot.
    expect(
      withFetchedWorkspaceSnapshots(
        configWith(true, [provider(claude, undefined, [{ name: "live" }])]),
        fetched,
      ).providers[0]?.workspaceSnapshots,
    ).toBeUndefined();

    // Older servers send every snapshot and every drop; their config stands.
    const legacy = configWith(false, [provider(claude)]);
    expect(withFetchedWorkspaceSnapshots(legacy, fetched)).toBe(legacy);

    // A fresh scan drops the cwd's other provider snapshots, as the server does.
    expect(record(fetched, claude, true, [])).toEqual([]);
  });

  it.effect("starts from cached configuration and persists the live projection", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedSome(CONFIG),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerConfigState({}).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          );
          expect(Option.getOrThrow(yield* SubscriptionRef.get(state)).config).toBe(CONFIG);

          const providers: ServerConfig["providers"] = [];
          yield* Queue.offer(events, {
            version: 1,
            type: "providerStatuses",
            payload: { providers },
          });
          const projected = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) =>
              Option.match(value, {
                onNone: () => false,
                onSome: (projection) => projection.latestEvent.type === "providerStatuses",
              }),
            ),
            Stream.runHead,
          );
          expect(Option.getOrThrow(Option.getOrThrow(projected)).config.providers).toEqual(
            providers,
          );
        }),
      );

      expect((yield* Queue.take(savedConfigs)).providers).toEqual([]);
    }),
  );

  it.effect("shows a reported stall but never caches it", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedSome(CONFIG),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerConfigState({}).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          );
          expect(Option.getOrThrow(yield* SubscriptionRef.get(state)).config).toBe(CONFIG);

          const lastEventLoopStall = {
            detectedAt: "2026-10-20T07:50:37.633Z",
            durationMs: 12_422,
            loadAverage: 219.4,
            cpuCount: 18,
          };
          yield* Queue.offer(events, {
            version: 1,
            type: "snapshot",
            config: { ...CONFIG, lastEventLoopStall },
          });
          const projected = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) =>
              Option.match(value, {
                onNone: () => false,
                onSome: (projection) => projection.source === "live",
              }),
            ),
            Stream.runHead,
          );
          expect(Option.getOrThrow(Option.getOrThrow(projected)).config.lastEventLoopStall).toEqual(
            lastEventLoopStall,
          );
        }),
      );

      // Cached, it would read as a fresh freeze on the next launch.
      expect(yield* Queue.take(savedConfigs)).not.toHaveProperty("lastEventLoopStall");
    }),
  );
});
