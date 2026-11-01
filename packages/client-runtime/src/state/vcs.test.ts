import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  AuthSourceControlWriteScope,
  WS_METHODS,
  VcsProcessExitError,
  type VcsListRefsResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

import {
  commitVcsRefsRefresh,
  createVcsEnvironmentAtoms,
  makeCachedVcsRefsChanges,
  resolveQuickAction,
} from "./vcs.ts";
import {
  invalidateCachedVcsRefs,
  invalidateVcsRefs,
  vcsRefsCacheStateAtom,
} from "./vcsRefInvalidation.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const CONNECTED_CONNECTION_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

const CACHED_REFS: VcsListRefsResult = {
  refs: [
    {
      name: "main",
      current: true,
      isDefault: true,
      worktreePath: "/repo",
    },
  ],
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: null,
  totalCount: 1,
};

const LIVE_REFS: VcsListRefsResult = {
  ...CACHED_REFS,
  refs: [
    {
      name: "release",
      current: true,
      isDefault: true,
      worktreePath: "/repo",
    },
  ],
};

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

function cacheWithRefs(
  refs: Option.Option<VcsListRefsResult>,
  overrides: Partial<Persistence.EnvironmentCacheStore["Service"]> = {},
) {
  return Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(refs),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
    ...overrides,
  });
}

describe("cached VCS refs", () => {
  it("invalidates all ref streams in the mutated environment", () => {
    const registry = AtomRegistry.make();
    const environment = {
      environmentId: TARGET.environmentId,
    };
    const otherEnvironment = {
      environmentId: EnvironmentId.make("environment-2"),
    };

    expect(registry.get(vcsRefsCacheStateAtom(environment))).toEqual({
      revision: 0,
      persistedCacheReadable: true,
    });
    expect(registry.get(vcsRefsCacheStateAtom(otherEnvironment))).toEqual({
      revision: 0,
      persistedCacheReadable: true,
    });

    invalidateVcsRefs(registry, environment);

    expect(registry.get(vcsRefsCacheStateAtom(environment))).toEqual({
      revision: 1,
      persistedCacheReadable: true,
    });
    expect(registry.get(vcsRefsCacheStateAtom(otherEnvironment))).toEqual({
      revision: 0,
      persistedCacheReadable: true,
    });
    registry.dispose();
  });

  it.effect("does not repersist a refresh superseded by ref invalidation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );
        const saved = yield* Ref.make<ReadonlyArray<VcsListRefsResult>>([]);
        const clears = yield* Ref.make(0);
        const revisionsObservedDuringClear = yield* Ref.make<ReadonlyArray<number>>([]);
        const cache = cacheWithRefs(Option.none(), {
          saveVcsRefs: (_environmentId, _cwd, refs) =>
            Ref.update(saved, (current) => [...current, refs]),
          clearVcsRefs: () =>
            Effect.all([
              Ref.update(clears, (count) => count + 1),
              Ref.update(revisionsObservedDuringClear, (current) => [
                ...current,
                registry.get(vcsRefsCacheStateAtom(TARGET)).revision,
              ]),
            ]).pipe(Effect.asVoid),
        });

        yield* invalidateCachedVcsRefs(registry, {
          environmentId: TARGET.environmentId,
          cwd: "/repo-worktree",
        }).pipe(Effect.provideService(Persistence.EnvironmentCacheStore, cache));

        expect(
          yield* commitVcsRefsRefresh(registry, cache, {
            environmentId: TARGET.environmentId,
            cwd: "/repo",
            refs: CACHED_REFS,
            expectedRevision: 0,
            persist: true,
          }),
        ).toBe(false);

        expect(yield* Ref.get(saved)).toEqual([]);
        expect(yield* Ref.get(clears)).toBe(1);
        expect(yield* Ref.get(revisionsObservedDuringClear)).toEqual([0]);
        expect(registry.get(vcsRefsCacheStateAtom(TARGET))).toEqual({
          revision: 1,
          persistedCacheReadable: true,
        });

        expect(
          yield* commitVcsRefsRefresh(registry, cache, {
            environmentId: TARGET.environmentId,
            cwd: "/repo",
            refs: LIVE_REFS,
            expectedRevision: 1,
            persist: true,
          }),
        ).toBe(true);
        expect(yield* Ref.get(saved)).toEqual([LIVE_REFS]);
      }),
    ),
  );

  it.effect("invalidates persisted refs when ref-affecting commands settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expectedError = new EnvironmentRpcUnavailableError({
          environmentId: TARGET.environmentId,
          message: "pull failed after fetching refs",
        });
        const client = {
          [WS_METHODS.vcsPull]: () => Effect.fail(expectedError),
          [WS_METHODS.vcsRefreshStatus]: () => Effect.void,
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
          _environmentId,
          effect,
        ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const clears = yield* Ref.make(0);
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Layer.succeed(
              Persistence.EnvironmentCacheStore,
              cacheWithRefs(Option.none(), {
                clearVcsRefs: () => Ref.update(clears, (count) => count + 1),
              }),
            ),
          ),
        );
        const atoms = createVcsEnvironmentAtoms(runtime);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );

        const result = yield* Effect.promise(() =>
          atoms.pull.run(registry, {
            environmentId: TARGET.environmentId,
            input: { cwd: "/repo" },
          }),
        );

        expect(AsyncResult.isFailure(result)).toBe(true);
        expect(yield* Ref.get(clears)).toBe(1);
        expect(registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(1);

        const refreshResult = yield* Effect.promise(() =>
          atoms.refreshStatus.run(registry, {
            environmentId: TARGET.environmentId,
            input: { cwd: "/repo" },
          }),
        );

        expect(AsyncResult.isSuccess(refreshResult)).toBe(true);
        expect(yield* Ref.get(clears)).toBe(2);
        expect(registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(2);
      }),
    ),
  );

  it.effect("suppresses persisted snapshots after an environment-wide clear fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );
        const persisted = yield* Ref.make<Option.Option<VcsListRefsResult>>(
          Option.some(CACHED_REFS),
        );
        const loads = yield* Ref.make(0);
        const clearAttempts = yield* Ref.make(0);
        const cache = cacheWithRefs(Option.none(), {
          loadVcsRefs: () =>
            Ref.update(loads, (count) => count + 1).pipe(Effect.andThen(Ref.get(persisted))),
          saveVcsRefs: (_environmentId, _cwd, refs) => Ref.set(persisted, Option.some(refs)),
          clearVcsRefs: () =>
            Ref.updateAndGet(clearAttempts, (count) => count + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(
                      new Persistence.ConnectionPersistenceError({
                        operation: "clear-vcs-refs",
                        message: "storage unavailable",
                      }),
                    )
                  : Ref.set(persisted, Option.none()),
              ),
            ),
        });

        yield* invalidateCachedVcsRefs(registry, {
          environmentId: TARGET.environmentId,
          cwd: "/repo",
        }).pipe(Effect.provideService(Persistence.EnvironmentCacheStore, cache));

        const state = registry.get(vcsRefsCacheStateAtom(TARGET));
        expect(state).toEqual({
          revision: 1,
          persistedCacheReadable: false,
        });

        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const refs = yield* Stream.unwrap(
          makeCachedVcsRefsChanges(
            { cwd: "/repo", limit: 100 },
            state.revision,
            registry,
            state.persistedCacheReadable,
          ).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          ),
        ).pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));

        yield* Effect.yieldNow;
        expect(yield* Ref.get(loads)).toBe(0);
        yield* Fiber.interrupt(refs);
        expect(registry.get(vcsRefsCacheStateAtom(TARGET))).toEqual(state);

        expect(
          yield* commitVcsRefsRefresh(registry, cache, {
            environmentId: TARGET.environmentId,
            cwd: "/repo",
            refs: LIVE_REFS,
            expectedRevision: state.revision,
            persist: true,
          }),
        ).toBe(true);
        const recoveredState = registry.get(vcsRefsCacheStateAtom(TARGET));
        expect(recoveredState).toEqual({
          revision: 1,
          persistedCacheReadable: true,
        });
        expect(yield* Ref.get(clearAttempts)).toBe(2);

        const recoveredRefs = yield* Stream.unwrap(
          makeCachedVcsRefsChanges(
            { cwd: "/repo", limit: 100 },
            recoveredState.revision,
            registry,
            recoveredState.persistedCacheReadable,
          ).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          ),
        ).pipe(Stream.runHead);

        expect(Option.getOrThrow(recoveredRefs)).toEqual(LIVE_REFS);
        expect(yield* Ref.get(loads)).toBe(1);
      }),
    ),
  );

  it.effect("loads an unfiltered branch list without a connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const refs = yield* Stream.unwrap(
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(
              Persistence.EnvironmentCacheStore,
              cacheWithRefs(Option.some(CACHED_REFS)),
            ),
          ),
        ).pipe(Stream.runHead);

        expect(Option.getOrThrow(refs)).toEqual(CACHED_REFS);
      }),
    ),
  );

  it.effect("waits silently for a session while the connection phase is still connected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const logs: unknown[] = [];
        const logger = Logger.make(({ message }) => logs.push(message));
        const liveSession = yield* SubscriptionRef.make(Option.none<RpcSession>());
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          session: liveSession,
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const refs = yield* Stream.unwrap(
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(
              Persistence.EnvironmentCacheStore,
              cacheWithRefs(Option.some(CACHED_REFS)),
            ),
          ),
        ).pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust("1 minute");
        expect(logs).toEqual([]);

        const client = {
          [WS_METHODS.vcsListRefs]: () => Effect.succeed(LIVE_REFS),
        } as unknown as WsRpcProtocolClient;
        yield* SubscriptionRef.set(liveSession, Option.some(session(client)));
        expect(yield* Fiber.join(refs)).toEqual([CACHED_REFS, LIVE_REFS]);
        expect(logs).toEqual([]);
      }),
    ),
  );

  it.effect("cancels an in-flight refresh and restarts when the RPC session changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const calls = yield* Ref.make(0);
        const interruptions = yield* Ref.make(0);
        const client = {
          [WS_METHODS.vcsListRefs]: () =>
            Ref.updateAndGet(calls, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() =>
                        Ref.update(interruptions, (interruptions) => interruptions + 1).pipe(
                          Effect.andThen(Deferred.succeed(interrupted, undefined)),
                        ),
                      ),
                    )
                  : Effect.succeed(LIVE_REFS),
              ),
            ),
        } as unknown as WsRpcProtocolClient;
        const liveSession = yield* SubscriptionRef.make(Option.some(session(client)));
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          session: liveSession,
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

        const fiber = yield* Stream.unwrap(
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
          ),
        ).pipe(Stream.runHead, Effect.forkChild);

        yield* Deferred.await(started);
        yield* SubscriptionRef.set(liveSession, Option.none());
        yield* Deferred.await(interrupted);
        expect(yield* Ref.get(interruptions)).toBe(1);

        yield* SubscriptionRef.set(liveSession, Option.some(session(client)));
        expect(Option.getOrThrow(yield* Fiber.join(fiber))).toEqual(LIVE_REFS);
        expect(yield* Ref.get(calls)).toBe(2);
      }),
    ),
  );

  it.effect("retries Git failures and cancels pending retries when the session is removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const warnings = yield* Queue.unbounded<unknown>();
        const logger = Logger.make(({ message }) => Queue.offerUnsafe(warnings, message));
        const failure = new VcsProcessExitError({
          operation: "listRefs",
          command: "git",
          cwd: "/repo",
          exitCode: 128,
          detail: "Could not read refs.",
        });
        const client = {
          [WS_METHODS.vcsListRefs]: () =>
            Ref.updateAndGet(calls, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count < 3 ? Effect.fail(failure) : Effect.succeed(LIVE_REFS),
              ),
            ),
        } as unknown as WsRpcProtocolClient;
        const liveSession = yield* SubscriptionRef.make(Option.some(session(client)));
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          session: liveSession,
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const refs = yield* Stream.unwrap(
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(
              Persistence.EnvironmentCacheStore,
              cacheWithRefs(Option.some(CACHED_REFS)),
            ),
          ),
        ).pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Queue.take(warnings);
        expect(yield* Ref.get(calls)).toBe(1);
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(calls)).toBe(2);
        expect(yield* Queue.size(warnings)).toBe(1);

        yield* SubscriptionRef.set(liveSession, Option.none());
        yield* TestClock.adjust("1 minute");
        expect(yield* Ref.get(calls)).toBe(2);
        expect(yield* Queue.size(warnings)).toBe(1);

        yield* SubscriptionRef.set(liveSession, Option.some(session(client)));
        expect(yield* Fiber.join(refs)).toEqual([CACHED_REFS, LIVE_REFS]);
        expect(yield* Ref.get(calls)).toBe(3);
      }),
    ),
  );

  it.effect("emits persisted refs before a live refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = {
          [WS_METHODS.vcsListRefs]: () => Effect.succeed(LIVE_REFS),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

        const refs = yield* Stream.unwrap(
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(
              Persistence.EnvironmentCacheStore,
              cacheWithRefs(Option.some(CACHED_REFS)),
            ),
          ),
        ).pipe(Stream.take(2), Stream.runCollect);

        expect(refs).toEqual([CACHED_REFS, LIVE_REFS]);
      }),
    ),
  );
});

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: grantedSessions }),
}));
const grantedSessions = Atom.family((_id: EnvironmentId) =>
  Atom.make(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthSourceControlWriteScope],
    }),
  ),
);

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("resolveQuickAction", () => {
  it("commits local changes without pushing when the branch is behind upstream", () => {
    const behind = status({ hasWorkingTreeChanges: true, behindCount: 2 });
    const commit = { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    expect(resolveQuickAction(behind, false)).toEqual(commit);
    expect(
      resolveQuickAction(
        {
          ...behind,
          pr: {
            number: 13,
            title: "Open PR",
            url: "https://example.com/pr/13",
            baseRef: "main",
            headRef: "feature/test",
            state: "open",
          },
        },
        false,
      ),
    ).toEqual(commit);
  });
});
