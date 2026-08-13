import {
  EnvironmentId,
  GitManagerError,
  WS_METHODS,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsStatusStreamEvent,
  type VcsStatusSubscriptionInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  EnvironmentRpcSubscriptionObserver,
  EnvironmentRpcUnavailableError,
  type EnvironmentRpcSubscriptionObservation,
} from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

import {
  commitVcsRefsRefresh,
  createVcsEnvironmentAtoms,
  makeCachedVcsRefsChanges,
  selectVcsStatusAtomForDemand,
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

const OTHER_TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-2"),
  label: "Other test environment",
  httpBaseUrl: "https://other-environment.example.test",
  wsBaseUrl: "wss://other-environment.example.test",
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
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function cacheWithRefs(
  refs: Option.Option<VcsListRefsResult>,
  overrides: Partial<Persistence.EnvironmentCacheStore["Service"]> = {},
) {
  return Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(refs),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
    ...overrides,
  });
}

function makeStatusSupervisor(target: PrimaryConnectionTarget, client: WsRpcProtocolClient) {
  return Effect.gen(function* () {
    return EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
      session: yield* SubscriptionRef.make(Option.some(session(client))),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  });
}

const makeVcsStatusSubscriptionHarness = Effect.gen(function* () {
  const started = yield* Ref.make<ReadonlyArray<EnvironmentRpcSubscriptionObservation>>([]);
  const finalized = yield* Ref.make<ReadonlyArray<EnvironmentRpcSubscriptionObservation>>([]);
  const startedSignals = yield* Queue.unbounded<EnvironmentRpcSubscriptionObservation>();
  const listRefsStarted = yield* Ref.make<ReadonlyArray<VcsListRefsInput>>([]);
  const listRefsInterrupted = yield* Ref.make<ReadonlyArray<VcsListRefsInput>>([]);
  const listRefsStartedSignals = yield* Queue.unbounded<VcsListRefsInput>();
  const observer = EnvironmentRpcSubscriptionObserver.of({
    observe: (observation) =>
      Effect.gen(function* () {
        yield* Ref.update(started, (current) => [...current, observation]);
        yield* Queue.offer(startedSignals, observation);
      }).pipe(Effect.map(() => Ref.update(finalized, (current) => [...current, observation]))),
  });
  const client = {
    [WS_METHODS.subscribeVcsStatus]: () => Stream.never,
    [WS_METHODS.vcsListRefs]: (input: VcsListRefsInput) =>
      Effect.gen(function* () {
        yield* Ref.update(listRefsStarted, (current) => [...current, input]);
        yield* Queue.offer(listRefsStartedSignals, input);
        return yield* Effect.never;
      }).pipe(
        Effect.onInterrupt(() => Ref.update(listRefsInterrupted, (current) => [...current, input])),
      ),
  } as unknown as WsRpcProtocolClient;
  const supervisors = new Map([
    [TARGET.environmentId, yield* makeStatusSupervisor(TARGET, client)],
    [OTHER_TARGET.environmentId, yield* makeStatusSupervisor(OTHER_TARGET, client)],
  ]);
  const supervisorFor = (environmentId: EnvironmentId) => {
    const supervisor = supervisors.get(environmentId);
    if (supervisor === undefined) {
      throw new Error(`Missing test supervisor for ${environmentId}`);
    }
    return supervisor;
  };
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (environmentId, effect) =>
    Effect.provideService(
      effect,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisorFor(environmentId),
    );
  const runStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["runStream"] = (
    environmentId,
    stream,
  ) =>
    Stream.provideService(
      stream,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisorFor(environmentId),
    );
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    environmentId,
    stream,
  ) =>
    Stream.provideService(
      stream,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisorFor(environmentId),
    );
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    runStream,
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
      Layer.succeed(EnvironmentRpcSubscriptionObserver, observer),
    ),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );

  return {
    atoms: createVcsEnvironmentAtoms(runtime),
    finalized,
    listRefsInterrupted,
    listRefsStarted,
    listRefsStartedSignals,
    registry,
    started,
    startedSignals,
    supervisorFor,
  };
});

const flushAtomDisposal = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* Effect.yieldNow;
});

function statusSubscriptionInput(
  observation: EnvironmentRpcSubscriptionObservation,
): VcsStatusSubscriptionInput {
  return observation.input as VcsStatusSubscriptionInput;
}

describe("VCS status subscription ownership", () => {
  it.effect("shares trimmed-cwd duplicates and promptly finalizes after the last release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeVcsStatusSubscriptionHarness;
        const target = {
          environmentId: TARGET.environmentId,
          input: { cwd: " /repo " },
        };
        const releaseFirst = harness.registry.mount(harness.atoms.status(target));
        const releaseSecond = harness.registry.mount(
          harness.atoms.status({
            environmentId: TARGET.environmentId,
            input: { cwd: "/repo" },
          }),
        );

        const observation = yield* Queue.take(harness.startedSignals);
        yield* Effect.yieldNow;
        expect(yield* Ref.get(harness.started)).toHaveLength(1);
        expect(observation).toMatchObject({
          environmentId: TARGET.environmentId,
          method: WS_METHODS.subscribeVcsStatus,
        });
        expect(statusSubscriptionInput(observation)).toEqual({
          cwd: "/repo",
          includeRemote: false,
        });

        releaseFirst();
        yield* flushAtomDisposal;
        expect(yield* Ref.get(harness.finalized)).toHaveLength(0);

        releaseSecond();
        yield* flushAtomDisposal;
        expect(yield* Ref.get(harness.finalized)).toHaveLength(1);
      }),
    ),
  );

  it.effect("shares local status across visible sidebar rows and releases it on collapse", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeVcsStatusSubscriptionHarness;
        const releaseFirstRowA = harness.registry.mount(
          selectVcsStatusAtomForDemand(harness.atoms, {
            demand: "local",
            target: {
              environmentId: TARGET.environmentId,
              input: { cwd: " /repo-a " },
            },
          }),
        );
        const releaseSecondRowA = harness.registry.mount(
          selectVcsStatusAtomForDemand(harness.atoms, {
            demand: "local",
            target: {
              environmentId: TARGET.environmentId,
              input: { cwd: "/repo-a" },
            },
          }),
        );
        const releaseRowB = harness.registry.mount(
          selectVcsStatusAtomForDemand(harness.atoms, {
            demand: "local",
            target: {
              environmentId: TARGET.environmentId,
              input: { cwd: "/repo-b" },
            },
          }),
        );

        yield* Queue.take(harness.startedSignals);
        yield* Queue.take(harness.startedSignals);
        yield* Effect.yieldNow;

        const started = yield* Ref.get(harness.started);
        expect(started).toHaveLength(2);
        expect(
          started
            .map(statusSubscriptionInput)
            .map((input) => `${input.cwd}:${String(input.includeRemote)}`)
            .sort(),
        ).toEqual(["/repo-a:false", "/repo-b:false"]);

        releaseRowB();
        yield* flushAtomDisposal;
        expect(
          (yield* Ref.get(harness.finalized)).map(
            (observation) => statusSubscriptionInput(observation).cwd,
          ),
        ).toEqual(["/repo-b"]);

        releaseFirstRowA();
        yield* flushAtomDisposal;
        expect(yield* Ref.get(harness.finalized)).toHaveLength(1);

        releaseSecondRowA();
        yield* flushAtomDisposal;
        const finalized = yield* Ref.get(harness.finalized);
        expect(
          finalized.map((observation) => statusSubscriptionInput(observation).cwd).sort(),
        ).toEqual(["/repo-a", "/repo-b"]);
        expect(started.length - finalized.length).toBe(0);
        expect(yield* Ref.get(harness.listRefsStarted)).toHaveLength(0);
      }),
    ),
  );

  it.effect("isolates status work by environment and normalized cwd", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeVcsStatusSubscriptionHarness;
        const releases = [
          harness.registry.mount(
            harness.atoms.status({
              environmentId: TARGET.environmentId,
              input: { cwd: "/repo" },
            }),
          ),
          harness.registry.mount(
            harness.atoms.status({
              environmentId: OTHER_TARGET.environmentId,
              input: { cwd: "/repo" },
            }),
          ),
          harness.registry.mount(
            harness.atoms.status({
              environmentId: TARGET.environmentId,
              input: { cwd: "/other-repo" },
            }),
          ),
        ];

        yield* Queue.take(harness.startedSignals);
        yield* Queue.take(harness.startedSignals);
        yield* Queue.take(harness.startedSignals);
        yield* Effect.yieldNow;

        const observedTargets = (yield* Ref.get(harness.started))
          .map(
            (observation) =>
              `${observation.environmentId}:${statusSubscriptionInput(observation).cwd}`,
          )
          .sort();
        expect(observedTargets).toEqual(
          [
            `${TARGET.environmentId}:/other-repo`,
            `${TARGET.environmentId}:/repo`,
            `${OTHER_TARGET.environmentId}:/repo`,
          ].sort(),
        );

        for (const release of releases) release();
        yield* flushAtomDisposal;
        expect(yield* Ref.get(harness.finalized)).toHaveLength(3);
      }),
    ),
  );

  it.effect("shares local and remote demand independently with explicit wire metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeVcsStatusSubscriptionHarness;
        const target = {
          environmentId: TARGET.environmentId,
          input: { cwd: "/repo" },
        };
        const releaseLocalFirst = harness.registry.mount(harness.atoms.status(target));
        const releaseLocalSecond = harness.registry.mount(harness.atoms.status({ ...target }));
        const releaseRemoteFirst = harness.registry.mount(harness.atoms.remoteStatus(target));
        const releaseRemoteSecond = harness.registry.mount(
          harness.atoms.remoteStatus({ ...target }),
        );

        yield* Queue.take(harness.startedSignals);
        yield* Queue.take(harness.startedSignals);
        yield* Effect.yieldNow;

        const startedInputs = (yield* Ref.get(harness.started))
          .map(statusSubscriptionInput)
          .sort((left, right) => Number(left.includeRemote) - Number(right.includeRemote));
        expect(startedInputs).toEqual([
          { cwd: "/repo", includeRemote: false },
          { cwd: "/repo", includeRemote: true },
        ]);

        releaseLocalFirst();
        releaseRemoteFirst();
        yield* flushAtomDisposal;
        expect(yield* Ref.get(harness.finalized)).toHaveLength(0);

        releaseRemoteSecond();
        yield* flushAtomDisposal;
        expect(
          (yield* Ref.get(harness.finalized)).map(
            (observation) => statusSubscriptionInput(observation).includeRemote,
          ),
        ).toEqual([true]);

        releaseLocalSecond();
        yield* flushAtomDisposal;
        expect(
          (yield* Ref.get(harness.finalized))
            .map((observation) => statusSubscriptionInput(observation).includeRemote)
            .sort(),
        ).toEqual([false, true]);
      }),
    ),
  );

  it.effect("retargets one consumer without releasing another owner of the old cwd", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeVcsStatusSubscriptionHarness;
        const targetA = {
          environmentId: TARGET.environmentId,
          input: { cwd: "/repo-a" },
        };
        const releaseAFirst = harness.registry.mount(harness.atoms.status(targetA));
        const releaseAMoving = harness.registry.mount(harness.atoms.status({ ...targetA }));

        yield* Queue.take(harness.startedSignals);
        releaseAMoving();
        const releaseB = harness.registry.mount(
          harness.atoms.status({
            environmentId: TARGET.environmentId,
            input: { cwd: "/repo-b" },
          }),
        );
        yield* Queue.take(harness.startedSignals);
        yield* flushAtomDisposal;

        expect(
          (yield* Ref.get(harness.started))
            .map((observation) => statusSubscriptionInput(observation).cwd)
            .sort(),
        ).toEqual(["/repo-a", "/repo-b"]);
        expect(yield* Ref.get(harness.finalized)).toHaveLength(0);

        releaseAFirst();
        yield* flushAtomDisposal;
        expect(
          (yield* Ref.get(harness.finalized)).map(
            (observation) => statusSubscriptionInput(observation).cwd,
          ),
        ).toEqual(["/repo-a"]);

        releaseB();
        yield* flushAtomDisposal;
        expect(
          (yield* Ref.get(harness.finalized))
            .map((observation) => statusSubscriptionInput(observation).cwd)
            .sort(),
        ).toEqual(["/repo-a", "/repo-b"]);
      }),
    ),
  );

  it.effect("recovers a mounted status atom only after its failed RPC session is replaced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeVcsStatusSubscriptionHarness;
        const attempts = yield* Ref.make<ReadonlyArray<"first" | "second">>([]);
        const firstAttempted = yield* Queue.unbounded<void>();
        const failure = new GitManagerError({
          operation: "VcsStatusBroadcaster.streamStatus",
          cwd: "/repo",
          detail: "Repository status is temporarily unavailable.",
        });
        const firstClient = {
          [WS_METHODS.subscribeVcsStatus]: () =>
            Stream.fromEffect(
              Ref.update(attempts, (current) => [...current, "first" as const]).pipe(
                Effect.andThen(Queue.offer(firstAttempted, undefined)),
              ),
            ).pipe(Stream.drain, Stream.concat(Stream.fail(failure))),
        } as unknown as WsRpcProtocolClient;
        const snapshot = {
          _tag: "snapshot",
          local: {
            isRepo: true,
            hasPrimaryRemote: true,
            isDefaultRef: false,
            refName: "feature/recovered-session",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          },
          remote: null,
        } satisfies VcsStatusStreamEvent;
        const secondClient = {
          [WS_METHODS.subscribeVcsStatus]: () =>
            Stream.make(snapshot).pipe(
              Stream.tap(() => Ref.update(attempts, (current) => [...current, "second" as const])),
              Stream.concat(Stream.never),
            ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = harness.supervisorFor(TARGET.environmentId);
        yield* SubscriptionRef.set(supervisor.session, Option.some(session(firstClient)));

        const atom = harness.atoms.status({
          environmentId: TARGET.environmentId,
          input: { cwd: "/repo" },
        });
        const release = harness.registry.mount(atom);
        yield* Queue.take(firstAttempted);
        yield* TestClock.adjust("10 minutes");
        expect(yield* Ref.get(attempts)).toEqual(["first"]);

        yield* SubscriptionRef.set(supervisor.session, Option.some(session(secondClient)));
        for (
          let attempt = 0;
          attempt < 100 && (yield* Ref.get(attempts)).length < 2;
          attempt += 1
        ) {
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(attempts)).toEqual(["first", "second"]);
        for (
          let attempt = 0;
          attempt < 100 && !AsyncResult.isSuccess(harness.registry.get(atom));
          attempt += 1
        ) {
          yield* Effect.yieldNow;
        }

        const recovered = harness.registry.get(atom);
        expect(AsyncResult.isSuccess(recovered)).toBe(true);
        if (AsyncResult.isSuccess(recovered)) {
          expect(recovered.value.refName).toBe("feature/recovered-session");
        }

        release();
        yield* flushAtomDisposal;
      }),
    ),
  );

  it.effect("interrupts in-flight ref-list work after its final consumer releases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeVcsStatusSubscriptionHarness;
        const target = {
          environmentId: TARGET.environmentId,
          input: { cwd: " /repo ", limit: 20, query: " feature " },
        };
        const releaseFirst = harness.registry.mount(harness.atoms.listRefs(target));
        const releaseSecond = harness.registry.mount(
          harness.atoms.listRefs({
            environmentId: TARGET.environmentId,
            input: { cwd: "/repo", limit: 20, query: "feature" },
          }),
        );

        const startedInput = yield* Queue.take(harness.listRefsStartedSignals);
        yield* Effect.yieldNow;
        const normalizedInput = { cwd: "/repo", limit: 20, query: "feature" };
        expect(startedInput).toEqual(normalizedInput);
        expect(yield* Ref.get(harness.listRefsStarted)).toHaveLength(1);

        releaseFirst();
        yield* flushAtomDisposal;
        expect(yield* Ref.get(harness.listRefsInterrupted)).toHaveLength(0);

        releaseSecond();
        yield* flushAtomDisposal;
        expect(yield* Ref.get(harness.listRefsInterrupted)).toEqual([normalizedInput]);
      }),
    ),
  );
});

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

  it.effect("preserves the caller's repository snapshot refresh policy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* Ref.make<ReadonlyArray<VcsListRefsInput>>([]);
        const client = {
          [WS_METHODS.vcsListRefs]: (input: VcsListRefsInput) =>
            Ref.update(requests, (current) => [...current, input]).pipe(Effect.as(LIVE_REFS)),
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

        yield* Stream.unwrap(
          makeCachedVcsRefsChanges({
            cwd: "/repo",
            limit: 20,
            query: "release",
            refKind: "remote",
          }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
          ),
        ).pipe(Stream.runHead);

        expect(yield* Ref.get(requests)).toEqual([
          {
            cwd: "/repo",
            limit: 20,
            query: "release",
            refKind: "remote",
          },
        ]);

        yield* Stream.unwrap(
          makeCachedVcsRefsChanges({
            cwd: "/repo",
            limit: 20,
            query: "release",
            refKind: "remote",
            refresh: true,
          }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
          ),
        ).pipe(Stream.runHead);

        expect(yield* Ref.get(requests)).toEqual([
          {
            cwd: "/repo",
            limit: 20,
            query: "release",
            refKind: "remote",
          },
          {
            cwd: "/repo",
            limit: 20,
            query: "release",
            refKind: "remote",
            refresh: true,
          },
        ]);
      }),
    ),
  );

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

  it.effect(
    "surfaces a cache-miss failure once and retries only in a new connection generation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const expectedError = new Error("Could not list Git refs.");
          const calls = yield* Ref.make(0);
          const attempts = yield* Queue.unbounded<number>();
          const connectionState = yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE);
          const client = {
            [WS_METHODS.vcsListRefs]: () =>
              Ref.updateAndGet(calls, (count) => count + 1).pipe(
                Effect.tap((count) => Queue.offer(attempts, count)),
                Effect.flatMap((count) =>
                  count === 1 ? Effect.fail(expectedError) : Effect.succeed(LIVE_REFS),
                ),
              ),
          } as unknown as WsRpcProtocolClient;
          const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
            target: TARGET,
            state: connectionState,
            session: yield* SubscriptionRef.make(Option.some(session(client))),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

          const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
            _environmentId,
            effect,
          ) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
          const runStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["runStream"] = (
            _environmentId,
            stream,
          ) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
          const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
            _environmentId,
            stream,
          ) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
          const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
            run,
            runStream,
            followStream,
          } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
          const runtime = Atom.runtime(
            Layer.mergeAll(
              Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
              Layer.succeed(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
            ),
          );
          const registry = yield* Effect.acquireRelease(
            Effect.sync(AtomRegistry.make),
            (registry) => Effect.sync(() => registry.dispose()),
          );
          const refsAtom = createVcsEnvironmentAtoms(runtime).listRefs({
            environmentId: TARGET.environmentId,
            input: { cwd: "/repo", limit: 100 },
          });
          registry.mount(refsAtom);

          expect(yield* Queue.take(attempts)).toBe(1);
          expect(yield* Ref.get(calls)).toBe(1);

          for (
            let attempt = 0;
            attempt < 100 && !AsyncResult.isFailure(registry.get(refsAtom));
            attempt += 1
          ) {
            yield* Effect.yieldNow;
          }
          const failed = registry.get(refsAtom);
          expect(AsyncResult.isFailure(failed)).toBe(true);
          if (AsyncResult.isFailure(failed)) {
            expect(failed.waiting).toBe(false);
            expect(Cause.squash(failed.cause)).toBe(expectedError);
          }

          yield* TestClock.adjust("1 minute");
          yield* Effect.yieldNow;
          expect(yield* Ref.get(calls)).toBe(1);

          yield* SubscriptionRef.set(connectionState, AVAILABLE_CONNECTION_STATE);
          yield* Effect.yieldNow;
          expect(yield* Ref.get(calls)).toBe(1);

          yield* SubscriptionRef.set(connectionState, {
            ...CONNECTED_CONNECTION_STATE,
            generation: 2,
          });
          expect(yield* Queue.take(attempts)).toBe(2);
          expect(yield* Ref.get(calls)).toBe(2);

          for (
            let attempt = 0;
            attempt < 100 && !AsyncResult.isSuccess(registry.get(refsAtom));
            attempt += 1
          ) {
            yield* Effect.yieldNow;
          }
          const recovered = registry.get(refsAtom);
          expect(AsyncResult.isSuccess(recovered)).toBe(true);
          if (AsyncResult.isSuccess(recovered)) {
            expect(recovered.value).toEqual(LIVE_REFS);
          }
        }).pipe(Effect.provide(TestClock.layer())),
      ),
  );

  it.effect("cancels an in-flight refresh when the connection generation changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const interruptions = yield* Ref.make(0);
        const connectionState = yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE);
        const client = {
          [WS_METHODS.vcsListRefs]: () =>
            Ref.updateAndGet(calls, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.never.pipe(
                      Effect.onInterrupt(() =>
                        Ref.update(interruptions, (interruptions) => interruptions + 1),
                      ),
                    )
                  : Effect.succeed(LIVE_REFS),
              ),
            ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: connectionState,
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

        const result = Stream.unwrap(
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
          ),
        ).pipe(Stream.runHead);
        const fiber = yield* Effect.forkChild(result);

        for (let attempt = 0; attempt < 100 && (yield* Ref.get(calls)) < 1; attempt += 1) {
          yield* Effect.yieldNow;
        }
        yield* SubscriptionRef.set(connectionState, AVAILABLE_CONNECTION_STATE);
        for (let attempt = 0; attempt < 100 && (yield* Ref.get(interruptions)) < 1; attempt += 1) {
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(interruptions)).toBe(1);

        yield* SubscriptionRef.set(connectionState, {
          ...CONNECTED_CONNECTION_STATE,
          generation: 2,
        });
        expect(Option.getOrThrow(yield* Fiber.join(fiber))).toEqual(LIVE_REFS);
        expect(yield* Ref.get(calls)).toBe(2);
      }),
    ),
  );

  it.effect("does not poll refs while the connection remains stable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const client = {
          [WS_METHODS.vcsListRefs]: () =>
            Ref.update(calls, (count) => count + 1).pipe(Effect.as(CACHED_REFS)),
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
        const stream = Stream.unwrap(
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
          ),
        ).pipe(Stream.runDrain);
        const fiber = yield* Effect.forkChild(stream);

        for (let attempt = 0; attempt < 100 && (yield* Ref.get(calls)) < 1; attempt += 1) {
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(calls)).toBe(1);

        yield* TestClock.adjust("1 minute");
        yield* Effect.yieldNow;
        expect(yield* Ref.get(calls)).toBe(1);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
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

  it.effect("emits only live refs for an explicit refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const persisted = yield* Ref.make<VcsListRefsResult | null>(null);
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
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100, refresh: true }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(
              Persistence.EnvironmentCacheStore,
              cacheWithRefs(Option.some(CACHED_REFS), {
                saveVcsRefs: (_environmentId, _cwd, refs) => Ref.set(persisted, refs),
              }),
            ),
          ),
        ).pipe(Stream.runHead);

        expect(Option.getOrThrow(refs)).toEqual(LIVE_REFS);
        expect(yield* Ref.get(persisted)).toEqual(LIVE_REFS);
      }),
    ),
  );
});
