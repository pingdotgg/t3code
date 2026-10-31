import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  RuntimeRequestId,
  EnvironmentId,
  MessageId,
  RunId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ShellSnapshot,
  type ServerConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { createThreadEnvironmentAtoms } from "./threadCommands.ts";
import * as ThreadUndo from "./threadUndo.ts";
import {
  makeThreadTriageOutboxStore,
  ThreadTriageOutboxStorageError,
  ThreadTriageOutboxStore,
  type ThreadTriageOutboxStoreShape,
} from "../platform/threadTriageOutboxStore.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";

const ENVIRONMENT_ID = EnvironmentId.make("remote");
const THREAD_ID = ThreadId.make("thread");
const NOW = DateTime.makeUnsafe("2026-09-12T10:00:00.000Z");
const FUTURE = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");
const APPROVAL = {
  id: RuntimeRequestId.make("approval"),
  kind: "command" as const,
  createdAt: NOW,
};
const USER_INPUT = {
  id: RuntimeRequestId.make("input"),
  kind: "user_input" as const,
  createdAt: NOW,
};
const SNAPSHOT: OrchestrationV2ShellSnapshot = {
  snapshotSequence: 1,
  schemaVersion: 2,
  archivedThreads: [],
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project"),
      title: "Remote thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: ProviderInstanceId.make("codex"),
      lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      itemCount: 0,
      visibleItemCount: 0,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      pullRequests: [],
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
    },
  ],
};

let randomCalls = 0;

const makeHarness = Effect.fn("TestThreadCommands.makeHarness")(function* (options?: {
  readonly loadEarlier?: () => Effect.Effect<ThreadHistoryController.ThreadHistoryLoadEarlierResult>;
  readonly reconcilePendingWork?: (threadId: ThreadId) => Effect.Effect<void>;
  readonly connected?: boolean;
  readonly storage?: {
    value: string | null;
    failWrites?: boolean;
    failReads?: boolean;
    writes?: Queue.Queue<string>;
    reads?: Queue.Queue<void>;
  };
  readonly versionGuard?: boolean;
  readonly operateScope?: boolean | null;
  /** The guard capability in the cached config, which may differ from the live server's. */
  readonly cachedVersionGuard?: boolean;
  readonly wrapStore?: (store: ThreadTriageOutboxStoreShape) => ThreadTriageOutboxStoreShape;
  readonly registered?: boolean | null;
}) {
  const requests = yield* Queue.unbounded<{
    command: OrchestrationV2Command;
    reply: Deferred.Deferred<{ sequence: number }, Error>;
  }>();
  const reconciled = yield* Queue.unbounded<ThreadId>();
  const configReads = yield* Queue.unbounded<void>();
  const liveSession = {
    initialConfig: Queue.offer(configReads, undefined).pipe(
      Effect.as({
        environment: { capabilities: { threadTriageVersionGuard: options?.versionGuard ?? true } },
      }),
    ),
    client: {
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<{ sequence: number }, Error>();
          yield* Queue.offer(requests, { command, reply });
          return yield* Deferred.await(reply);
        }),
    },
  } as unknown as RpcSession;
  const session = yield* SubscriptionRef.make(
    options?.connected === false ? Option.none<RpcSession>() : Option.some(liveSession),
  );
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID, label: "Mac" },
    session,
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const storage = options?.storage ?? { value: null };
  const store = makeThreadTriageOutboxStore({
    read: Effect.suspend(() => {
      if (storage.reads) Queue.offerUnsafe(storage.reads, undefined);
      return storage.failReads
        ? Effect.fail(new ThreadTriageOutboxStorageError({ cause: "unreadable" }))
        : Effect.succeed(storage.value);
    }),
    modify: (next) =>
      Effect.suspend(() => {
        if (storage.reads) Queue.offerUnsafe(storage.reads, undefined);
        if (storage.failReads) {
          return Effect.fail(new ThreadTriageOutboxStorageError({ cause: "unreadable" }));
        }
        const value = next(storage.value);
        if (value === null) return Effect.void;
        if (storage.failWrites) {
          return Effect.fail(new ThreadTriageOutboxStorageError({ cause: "disk full" }));
        }
        return Effect.sync(() => {
          storage.value = value;
          if (storage.writes) Queue.offerUnsafe(storage.writes, value);
        });
      }),
  });
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          // Distinct bytes per call, so each queued change gets its own command id.
          randomBytes: (size) => new Uint8Array(size).fill(++randomCalls % 256),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
      Layer.succeed(ThreadTriageOutboxStore, options?.wrapStore?.(store) ?? store),
      Layer.succeed(
        ThreadHistoryController.ThreadHistoryController,
        ThreadHistoryController.ThreadHistoryController.of({
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          loadEarlier: () => options?.loadEarlier?.() ?? Effect.die("unused"),
          reconcilePendingWork: (_environmentId, threadId) =>
            options?.reconcilePendingWork?.(threadId) ?? Queue.offer(reconciled, threadId),
        }),
      ),
    ),
  );
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) => Atom.make(SNAPSHOT));
  const statusAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<EnvironmentShellStatus>(options?.connected === false ? "cached" : "live"),
  );
  const operateScopeAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<boolean | null>(options?.operateScope === undefined ? true : options.operateScope),
  );
  const serverConfigAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make({
      environment: {
        capabilities: { threadTriageVersionGuard: options?.cachedVersionGuard ?? true },
      },
    } as unknown as ServerConfig),
  );
  const registeredAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<boolean | null>(options?.registered === undefined ? true : options.registered),
  );
  const commands = createThreadEnvironmentAtoms(runtime, snapshotAtom, {
    shellStatusAtom: statusAtom,
    operateScopeAtom,
    serverConfigAtom,
    registeredAtom,
  });
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const visibleAtom = commands.snapshotAtom(ENVIRONMENT_ID);
  registry.mount(visibleAtom);
  const reconnect = (status: EnvironmentShellStatus = "live") =>
    SubscriptionRef.set(session, Option.some(liveSession)).pipe(
      Effect.andThen(Effect.sync(() => registry.set(statusAtom(ENVIRONMENT_ID), status))),
    );
  const disconnect = SubscriptionRef.set(session, Option.none()).pipe(
    Effect.andThen(Effect.sync(() => registry.set(statusAtom(ENVIRONMENT_ID), "cached"))),
  );
  return {
    registry,
    commands,
    snapshotAtom,
    statusAtom,
    operateScopeAtom,
    registeredAtom,
    visibleAtom,
    requests,
    reconciled,
    storage,
    store,
    configReads,
    reconnect,
    disconnect,
  };
});

describe("history loading", () => {
  it.effect("sends a message on the thread while earlier history is loading", () =>
    Effect.gen(function* () {
      const historyStarted = yield* Deferred.make<void>();
      const historyReply =
        yield* Deferred.make<ThreadHistoryController.ThreadHistoryLoadEarlierResult>();
      const h = yield* makeHarness({
        loadEarlier: () =>
          Deferred.succeed(historyStarted, undefined).pipe(
            Effect.andThen(Deferred.await(historyReply)),
          ),
      });
      yield* Effect.addFinalizer(() => Deferred.succeed(historyReply, { _tag: "loaded" }));
      const history = h.commands.loadEarlierHistory.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      yield* Deferred.await(historyStarted);
      const send = h.commands.startTurn.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: {
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message"),
            role: "user",
            text: "Send while history loads",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode: "start",
        },
      });
      // Dispatched after Send on another thread, so it arrives first only if Send is queued.
      const controlThreadId = ThreadId.make("control-thread");
      const control = h.commands.interruptTurn.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: controlThreadId, runId: RunId.make("control-run") },
      });
      const first = yield* Queue.take(h.requests);
      yield* Deferred.succeed(first.reply, { sequence: 1 });
      yield* Deferred.succeed(historyReply, { _tag: "loaded" });
      const second = yield* Queue.take(h.requests);
      yield* Deferred.succeed(second.reply, { sequence: 2 });
      const results = yield* Effect.promise(() => Promise.all([history, send, control]));

      expect(first.command).toMatchObject({ type: "message.dispatch", threadId: THREAD_ID });
      expect(second.command).toMatchObject({ type: "run.interrupt", threadId: controlThreadId });
      expect(results.map((value) => value._tag)).toEqual(["Success", "Success", "Success"]);
    }),
  );
});

describe("interrupt turn", () => {
  // A stale cached item has nothing left to interrupt, so the server can reject Stop.
  it.effect("reconciles pending work when the server rejects the interrupt", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = h.commands.interruptTurn.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, runId: RunId.make("finished-run") },
      });
      const request = yield* Queue.take(h.requests);
      expect(request.command.type).toBe("run.interrupt");
      yield* Deferred.fail(request.reply, new Error("Run is not interruptible"));
      expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
      expect(yield* Queue.take(h.reconciled)).toBe(THREAD_ID);
    }),
  );

  // Mirrors the thread state's handler: the lookup runs in the thread's scope and is joined.
  const stopWithBlockedLookup = Effect.fn("stopWithBlockedLookup")(function* () {
    const threadScope = yield* Scope.make();
    const asked = yield* Deferred.make<void>();
    const h = yield* makeHarness({
      reconcilePendingWork: () =>
        Deferred.succeed(asked, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.forkIn(threadScope),
          Effect.flatMap(Fiber.join),
        ),
    });
    const result = h.commands.interruptTurn.run(h.registry, {
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, runId: RunId.make("running-run") },
    });
    const request = yield* Queue.take(h.requests);
    yield* Deferred.succeed(request.reply, { sequence: 1 });
    yield* Deferred.await(asked);
    return { threadScope, result };
  });

  it.effect("resolves Stop without waiting for the pending work lookup", () =>
    Effect.gen(function* () {
      const { threadScope, result } = yield* stopWithBlockedLookup();
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
      yield* Scope.close(threadScope, Exit.void);
    }),
  );

  it.effect("keeps an accepted Stop when the thread closes during the lookup", () =>
    Effect.gen(function* () {
      const { threadScope, result } = yield* stopWithBlockedLookup();
      yield* Scope.close(threadScope, Exit.void);
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
    }),
  );
});

describe("remote thread lifecycle commands", () => {
  const actions = [
    ["settle", {}, { settledOverride: "settled", pinnedAt: null, snoozedUntil: null }],
    ["unsettle", { reason: "user" }, { settledOverride: "active", settledAt: null }],
    ["snooze", { snoozedUntil: "2099-01-01T00:00:00.000Z" }, { snoozedUntil: FUTURE }],
    ["unsnooze", { reason: "user" }, { snoozedUntil: null, snoozedAt: null }],
    ["pin", { orderKey: "a" }, { pinnedAt: expect.any(Object), pinOrderKey: "a" }],
    ["unpin", {}, { pinnedAt: null, pinOrderKey: null }],
    ["setAutoSettle", { enabled: false }, { autoSettleDisabledAt: expect.any(Object) }],
    ["reorderPin", { orderKey: "b" }, { pinOrderKey: "b" }],
    ["reorderActive", { orderKey: "b" }, { activeOrderKey: "b" }],
  ] as const;

  it.effect.each(actions)(
    "shows %s before a delayed remote reply and rolls back a rejection",
    ([action, input, expected]) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const source = h.snapshotAtom(ENVIRONMENT_ID);
        const initial = {
          ...SNAPSHOT,
          threads: [
            {
              ...SNAPSHOT.threads[0]!,
              ...(action === "unsettle" || action === "pin"
                ? { settledOverride: "settled" as const, settledAt: NOW }
                : {}),
              ...(action === "unsnooze" || action === "settle" || action === "pin"
                ? { snoozedUntil: FUTURE, snoozedAt: NOW }
                : {}),
              ...(action === "unpin" || action === "settle"
                ? { pinnedAt: NOW, pinOrderKey: "a" }
                : {}),
            },
          ],
        };
        h.registry.set(source, initial);
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: {
            threadId: THREAD_ID,
            commandId: CommandId.make(action),
            reason: "user",
            enabled: false,
            orderKey: "a",
            snoozedUntil: "2099-01-01T00:00:00.000Z",
            ...input,
          },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(expected);
        const request = yield* Queue.take(h.requests);
        expect(h.registry.get(source)).toBe(initial);
        yield* Deferred.fail(request.reply, new Error("Remote rejected the action"));
        const settled: Promise<{ readonly _tag: string }> = result;
        expect((yield* Effect.promise(() => settled))._tag).toBe("Failure");
        expect(h.registry.get(h.visibleAtom)).toBe(initial);
      }),
  );

  it.effect("restamps snoozedAt when re-snoozing to the same wake time", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const earlierSnoozedAt = DateTime.makeUnsafe("2000-01-01T00:00:00.000Z");
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
        ...SNAPSHOT,
        threads: [{ ...SNAPSHOT.threads[0]!, snoozedUntil: FUTURE, snoozedAt: earlierSnoozedAt }],
      });
      const result = h.commands.snooze.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, snoozedUntil: DateTime.formatIso(FUTURE) },
      });
      const snoozedAt = h.registry.get(h.visibleAtom)?.threads[0]?.snoozedAt;
      expect(DateTime.toEpochMillis(snoozedAt!)).toBeGreaterThan(
        DateTime.toEpochMillis(earlierSnoozedAt),
      );
      const request = yield* Queue.take(h.requests);
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
    }),
  );

  it.effect("keeps the preview after acknowledgement until the matching shell update arrives", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      yield* Deferred.succeed(request.reply, { sequence: 3 });
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
      const changed = {
        ...SNAPSHOT,
        snapshotSequence: 2,
        threads: [{ ...SNAPSHOT.threads[0]!, title: "Renamed remotely" }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), changed);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject({
        title: "Renamed remotely",
        settledOverride: "settled",
      });
      const confirmed = {
        ...changed,
        snapshotSequence: 3,
        threads: [
          {
            ...changed.threads[0]!,
            settledOverride: "settled" as const,
            settledAt: DateTime.makeUnsafe("2026-09-12T12:00:00.000Z"),
          },
        ],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
      expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), { ...SNAPSHOT, snapshotSequence: 4 });
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBeNull();
    }),
  );

  it.effect(
    "shows a queued reverse action immediately and preserves it if the earlier action fails",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const settle = h.commands.settle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID },
        });
        const first = yield* Queue.take(h.requests);
        const unsettle = h.commands.unsettle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, reason: "user" },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("active");
        yield* Deferred.fail(first.reply, new Error("Settle rejected"));
        yield* Effect.promise(() => settle);
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("active");
        const second = yield* Queue.take(h.requests);
        expect(second.command.type).toBe("thread.unsettle");
        const confirmed = {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "active" as const }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
        yield* Deferred.succeed(second.reply, { sequence: 2 });
        yield* Effect.promise(() => unsettle);
        expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      }),
  );

  it.effect("isolates environments and does not restore a remotely removed thread", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const otherEnvironment = EnvironmentId.make("other-remote");
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      expect(h.registry.get(h.commands.snapshotAtom(otherEnvironment))).toBe(SNAPSHOT);
      const removed = { ...SNAPSHOT, snapshotSequence: 2, threads: [] };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), removed);
      expect(h.registry.get(h.visibleAtom)?.threads).toEqual([]);
      yield* Deferred.fail(request.reply, new Error("Thread removed"));
      yield* Effect.promise(() => result);
      expect(h.registry.get(h.visibleAtom)).toBe(removed);
    }),
  );

  const undoableActions = ["settle", "snooze"] as const;

  it.effect.each(undoableActions)("restores a confirmed %s when a queued undo fails", (action) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const parked =
        action === "settle" ? { settledOverride: "settled" as const } : { snoozedUntil: FUTURE };
      const awake = action === "settle" ? { settledOverride: "active" } : { snoozedUntil: null };
      const result = h.commands[action].run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
      });
      const first = yield* Queue.take(h.requests);
      const undo = h.commands[action === "settle" ? "unsettle" : "unsnooze"].run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, reason: "user" },
      });
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
      yield* Deferred.succeed(first.reply, { sequence: 2 });
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
      const confirmed = {
        ...SNAPSHOT,
        snapshotSequence: 2,
        threads: [{ ...SNAPSHOT.threads[0]!, ...parked }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
      const second = yield* Queue.take(h.requests);
      expect(second.command.type).toBe(action === "settle" ? "thread.unsettle" : "thread.unsnooze");
      yield* Deferred.fail(second.reply, new Error("Undo rejected"));
      expect((yield* Effect.promise(() => undo))._tag).toBe("Failure");
      expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
    }),
  );

  it.effect.each(undoableActions)(
    "preserves a newer approval when the %s reply arrives after the shell",
    (action) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
        });
        const request = yield* Queue.take(h.requests);
        const newer = {
          ...SNAPSHOT,
          snapshotSequence: 3,
          threads: [{ ...SNAPSHOT.threads[0]!, pendingRuntimeRequest: APPROVAL }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), newer);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(newer.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)).toBe(newer);
      }),
  );

  it.effect.each(undoableActions)(
    "shows an accepted %s while the shell still has an old input request",
    (action) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const stale = {
          ...SNAPSHOT,
          threads: [{ ...SNAPSHOT.threads[0]!, pendingRuntimeRequest: USER_INPUT }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), stale);
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
        });
        const request = yield* Queue.take(h.requests);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(stale.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(
          action === "settle" ? { settledOverride: "settled" } : { snoozedUntil: FUTURE },
        );
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.pendingRuntimeRequest).toBeNull();
        expect(h.registry.get(h.snapshotAtom(ENVIRONMENT_ID))).toBe(stale);
      }),
  );
});

const waitFor = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  done: (value: A) => boolean,
) =>
  Effect.callback<void>((resume) => {
    if (done(registry.get(atom))) return resume(Effect.void);
    const unsubscribe = registry.subscribe(atom, (value) => {
      if (!done(value)) return;
      unsubscribe();
      resume(Effect.void);
    });
    return Effect.sync(unsubscribe);
  });

describe("settle and snooze while the environment is offline", () => {
  const settle = { environmentId: ENVIRONMENT_ID, input: { threadId: THREAD_ID } };
  const snooze = {
    environmentId: ENVIRONMENT_ID,
    input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
  };
  const stored = (storage: { value: string | null }) =>
    storage.value === null
      ? []
      : (JSON.parse(storage.value) as { entries: Array<Record<string, unknown>> }).entries;

  // An older server cannot check the sequence, so the connected command goes out unguarded.
  it.effect.each([
    { action: "settle", guarded: true },
    { action: "snooze", guarded: true },
    { action: "settle", guarded: false },
    { action: "snooze", guarded: false },
  ] as const)(
    "sends a $action taken before shell synchronization (version guard: $guarded)",
    ({ action, guarded }) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ versionGuard: guarded, cachedVersionGuard: guarded });
        h.registry.set(h.statusAtom(ENVIRONMENT_ID), "synchronizing");
        const result = h.commands[action].run(h.registry, snooze);
        const request = yield* Queue.take(h.requests);
        expect(Reflect.get(request.command, "snapshotSequence")).toBe(guarded ? 1 : undefined);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
      }),
  );

  it.effect("discovers a change another tab queued after this tab loaded", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const loaded = yield* Deferred.make<void>();
      const second = yield* makeHarness({
        connected: false,
        storage,
        wrapStore: (store) => ({
          ...store,
          load: store.load.pipe(Effect.tap(() => Deferred.succeed(loaded, undefined))),
        }),
      });
      yield* Deferred.await(loaded);
      const first = yield* makeHarness({ connected: false, storage });
      yield* Effect.promise(() => first.commands.settle.run(first.registry, settle));
      yield* second.reconnect();
      const replayed = yield* Queue.take(second.requests);
      expect(replayed.command.type).toBe("thread.settle");
    }),
  );

  it.effect("clears the pending entry after Undo starts during a replay with a lost reply", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      yield* h.reconnect();
      const replay = yield* Queue.take(h.requests);
      const undo = h.commands.unsettle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, reason: "user" },
      });
      yield* Deferred.fail(replay.reply, lostReply());
      const request = yield* Queue.take(h.requests);
      yield* Deferred.succeed(request.reply, { sequence: 3 });
      expect((yield* Effect.promise(() => undo))._tag).toBe("Success");
      expect(h.registry.get(pending).size).toBe(0);
      expect(stored(h.storage)).toEqual([]);
    }),
  );

  it.effect("does not accept an invisible offline settle of a cached running thread", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
        ...SNAPSHOT,
        threads: [{ ...SNAPSHOT.threads[0]!, status: "running" }],
      });
      const result = yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      expect(result._tag).toBe("Failure");
      expect(stored(h.storage)).toEqual([]);
    }),
  );

  it.effect("loads every environment before refreshing an already-live shell", () =>
    Effect.gen(function* () {
      const other = EnvironmentId.make("other");
      const secondStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reads = 0;
      const storage = {
        value: JSON.stringify({
          entries: [
            {
              environmentId: other,
              threadId: THREAD_ID,
              commandId: "other-settle",
              action: { type: "settle" },
              queuedAt: "2026-09-12T10:00:00.000Z",
              snapshotSequence: 1,
            },
          ],
          operableEnvironmentIds: [other],
        }),
      };
      const h = yield* makeHarness({
        storage,
        operateScope: null,
        wrapStore: (store) => ({
          ...store,
          load: Effect.suspend(() =>
            ++reads === 2
              ? Deferred.succeed(secondStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(store.load),
                )
              : store.load,
          ),
        }),
      });
      yield* Deferred.await(secondStarted);
      yield* Deferred.succeed(release, undefined);
      const pending = h.commands.pendingSyncAtom(other);
      yield* waitFor(h.registry, pending, (threads) => threads.has(THREAD_ID));
      expect(h.registry.get(h.commands.offlineTriagePermittedAtom(other))).toBe(true);
    }),
  );

  it.effect("keeps a pending settle when snooze would discard it offline", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      const queued = h.storage.value;
      const result = yield* Effect.promise(() => h.commands.snooze.run(h.registry, snooze));
      expect(result._tag).toBe("Failure");
      expect(h.storage.value).toBe(queued);
    }),
  );

  it.effect("applies a settle locally and replays it with the cached version on reconnect", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      const result = yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      expect(result._tag).toBe("Success");
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("settled");
      expect(h.registry.get(pending).has(THREAD_ID)).toBe(true);
      const [entry] = stored(h.storage);
      expect(entry).toMatchObject({
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        action: { type: "settle" },
        snapshotSequence: 1,
      });

      yield* h.reconnect("synchronizing");
      expect(yield* Queue.size(h.requests)).toBe(0);
      h.registry.set(h.statusAtom(ENVIRONMENT_ID), "live");
      const request = yield* Queue.take(h.requests);
      expect(request.command).toMatchObject({
        type: "thread.settle",
        commandId: entry!.commandId,
        threadId: THREAD_ID,
        snapshotSequence: 1,
      });
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      yield* waitFor(h.registry, pending, (threads) => threads.size === 0);
      expect(stored(h.storage)).toEqual([]);
      // Stays settled until the shell catches up with the accepted command.
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("settled");
      const confirmed = {
        ...SNAPSHOT,
        snapshotSequence: 2,
        threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "settled" as const, settledAt: NOW }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
      expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
    }),
  );

  it.effect.each(["settle", "snooze"] as const)(
    "replays a %s when reconnect finishes during the queue write",
    (action) =>
      Effect.gen(function* () {
        const putStarted = yield* Deferred.make<void>();
        const putReleased = yield* Deferred.make<void>();
        const h = yield* makeHarness({
          connected: false,
          wrapStore: (store) => ({
            ...store,
            put: (entry, stillCurrent) =>
              Deferred.succeed(putStarted, undefined).pipe(
                Effect.andThen(Deferred.await(putReleased)),
                Effect.andThen(store.put(entry, stillCurrent)),
              ),
          }),
        });
        const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
        h.registry.mount(pending);
        const queued = h.commands[action].run(h.registry, snooze);
        yield* Deferred.await(putStarted);
        yield* h.reconnect();
        yield* Deferred.succeed(putReleased, undefined);
        expect((yield* Effect.promise(() => queued))._tag).toBe("Success");
        const request = yield* Queue.take(h.requests);
        expect(request.command.type).toBe(`thread.${action}`);
        expect(request.command.commandId).toBe(stored(h.storage)[0]!.commandId);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        yield* waitFor(h.registry, pending, (threads) => threads.size === 0);
      }),
  );

  it.effect("replays a queued change when an Undo that failed lets go after reconnect", () =>
    Effect.gen(function* () {
      const cancelStarted = yield* Deferred.make<void>();
      const cancelReleased = yield* Deferred.make<void>();
      const h = yield* makeHarness({
        connected: false,
        wrapStore: (store) => ({
          ...store,
          cancel: () =>
            Deferred.succeed(cancelStarted, undefined).pipe(
              Effect.andThen(Deferred.await(cancelReleased)),
              Effect.andThen(
                Effect.fail(new ThreadTriageOutboxStorageError({ cause: "disk full" })),
              ),
            ),
        }),
      });
      h.registry.mount(h.commands.pendingSyncAtom(ENVIRONMENT_ID));
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      const undo = h.commands.unsettle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, reason: "user" },
      });
      yield* Deferred.await(cancelStarted);
      yield* h.reconnect();
      yield* Deferred.succeed(cancelReleased, undefined);
      expect((yield* Effect.promise(() => undo))._tag).toBe("Failure");
      const request = yield* Queue.take(h.requests);
      expect(request.command.type).toBe("thread.settle");
    }),
  );

  it.effect("restores a queued snooze after a restart and replays it once", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const first = yield* makeHarness({ connected: false, storage });
      expect(
        (yield* Effect.promise(() => first.commands.snooze.run(first.registry, snooze)))._tag,
      ).toBe("Success");
      const [entry] = stored(storage);

      const restarted = yield* makeHarness({ connected: false, storage });
      const pending = restarted.commands.pendingSyncAtom(ENVIRONMENT_ID);
      restarted.registry.mount(pending);
      yield* waitFor(restarted.registry, pending, (threads) => threads.has(THREAD_ID));
      expect(restarted.registry.get(restarted.visibleAtom)?.threads[0]?.snoozedUntil).toEqual(
        FUTURE,
      );

      yield* restarted.reconnect();
      const request = yield* Queue.take(restarted.requests);
      expect(request.command).toMatchObject({
        type: "thread.snooze",
        commandId: entry!.commandId,
        snoozedUntil: "2099-01-01T00:00:00.000Z",
      });
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      yield* waitFor(restarted.registry, pending, (threads) => threads.size === 0);
      expect(yield* Queue.size(restarted.requests)).toBe(0);
    }),
  );

  it.effect("shows the server state when the server rejects the replay as changed", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      const changed = {
        ...SNAPSHOT,
        snapshotSequence: 5,
        threads: [
          { ...SNAPSHOT.threads[0]!, title: "Changed on the Mac", status: "running" as const },
        ],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), changed);
      yield* h.reconnect();
      const request = yield* Queue.take(h.requests);
      yield* Deferred.fail(request.reply, new Error("Thread changed after the client's version."));
      yield* waitFor(h.registry, pending, (threads) => threads.size === 0);
      expect(stored(h.storage)).toEqual([]);
      expect(h.registry.get(h.visibleAtom)).toBe(changed);
    }),
  );

  it.effect("keeps the queued action when the connection drops again and retries it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      const [entry] = stored(h.storage);
      // The shell reports live from a stale stream while the session is already gone.
      h.registry.set(h.statusAtom(ENVIRONMENT_ID), "live");
      yield* h.disconnect;
      expect(h.registry.get(pending).has(THREAD_ID)).toBe(true);
      yield* h.reconnect();
      const request = yield* Queue.take(h.requests);
      expect(request.command.commandId).toBe(entry!.commandId);
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      yield* waitFor(h.registry, pending, (threads) => threads.size === 0);
    }),
  );

  it.effect.each([
    ["settle", "unsettle"],
    ["snooze", "unsnooze"],
  ] as const)("undoing a queued %s cancels it without contacting the server", ([action, undo]) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      yield* Effect.promise(() => h.commands[action].run(h.registry, snooze));
      const result = yield* Effect.promise(() =>
        h.commands[undo].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, reason: "user" },
        }),
      );
      expect(result._tag === "Success" && ThreadUndo.cancelledPendingSync(result.value)).toBe(true);
      expect(h.registry.get(pending).size).toBe(0);
      expect(stored(h.storage)).toEqual([]);
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
      yield* h.reconnect();
      expect(yield* Queue.size(h.requests)).toBe(0);
    }),
  );

  it.effect("drops a queued snooze that expired before the reconnect", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const h = yield* makeHarness({ connected: false, storage });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      yield* Effect.promise(() => h.commands.snooze.run(h.registry, snooze));
      storage.value = storage.value!.replace(
        "2099-01-01T00:00:00.000Z",
        "2000-01-01T00:00:00.000Z",
      );
      const restarted = yield* makeHarness({ connected: false, storage });
      const restartedPending = restarted.commands.pendingSyncAtom(ENVIRONMENT_ID);
      restarted.registry.mount(restartedPending);
      yield* waitFor(restarted.registry, restartedPending, (threads) => threads.size === 1);
      yield* restarted.reconnect();
      yield* waitFor(restarted.registry, restartedPending, (threads) => threads.size === 0);
      expect(yield* Queue.size(restarted.requests)).toBe(0);
      expect(stored(storage)).toEqual([]);
    }),
  );

  it.effect("keeps the not-connected failure when the change cannot be saved", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        connected: false,
        storage: { value: null, failWrites: true },
      });
      const result = yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      expect(result._tag).toBe("Failure");
      expect(String(result._tag === "Failure" ? Cause.squash(result.cause) : "")).toContain(
        "Mac is not connected.",
      );
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
    }),
  );

  it.effect("refuses to queue for a server that cannot check the snapshot", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false, cachedVersionGuard: false });
      const result = yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      expect(result._tag === "Failure" ? String(Cause.squash(result.cause)) : "Success").toContain(
        "Mac is not connected. Update its server to settle or snooze while it is offline.",
      );
      expect(h.registry.get(h.commands.pendingSyncAtom(ENVIRONMENT_ID)).size).toBe(0);
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
    }),
  );

  it.effect("keeps a queued change when the reconnected server cannot check it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false, versionGuard: false });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      yield* h.reconnect();
      yield* Queue.take(h.configReads);
      // A second reconnect only replays after the first attempt finished.
      yield* h.disconnect;
      yield* h.reconnect();
      yield* Queue.take(h.configReads);
      expect(yield* Queue.size(h.requests)).toBe(0);
      expect(h.registry.get(pending).has(THREAD_ID)).toBe(true);
      expect(stored(h.storage)).toHaveLength(1);
    }),
  );

  it.effect("does not send a queued change cancelled while an earlier one replays", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      const cancelledThreadId = ThreadId.make("cancelled-thread");
      const laterThreadId = ThreadId.make("later-thread");
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
        ...SNAPSHOT,
        threads: [
          ...SNAPSHOT.threads,
          { ...SNAPSHOT.threads[0]!, id: cancelledThreadId },
          { ...SNAPSHOT.threads[0]!, id: laterThreadId },
        ],
      });
      h.registry.mount(h.commands.pendingSyncAtom(ENVIRONMENT_ID));
      for (const threadId of [THREAD_ID, cancelledThreadId, laterThreadId]) {
        yield* Effect.promise(() =>
          h.commands.settle.run(h.registry, { environmentId: ENVIRONMENT_ID, input: { threadId } }),
        );
      }
      yield* h.reconnect();
      const first = yield* Queue.take(h.requests);
      expect(first.command).toMatchObject({ type: "thread.settle", threadId: THREAD_ID });
      const undo = yield* Effect.promise(() =>
        h.commands.unsettle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: cancelledThreadId, reason: "user" },
        }),
      );
      expect(undo._tag).toBe("Success");
      yield* Deferred.succeed(first.reply, { sequence: 2 });
      const next = yield* Queue.take(h.requests);
      expect(next.command).toMatchObject({ type: "thread.settle", threadId: laterThreadId });
    }),
  );

  it.effect("forgets an environment's queued changes in memory when it is removed", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      yield* h.store.clearEnvironment(ENVIRONMENT_ID);
      expect(h.registry.get(pending).size).toBe(0);
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
      expect(stored(h.storage)).toEqual([]);
    }),
  );

  it.effect("keeps the earlier queued change when its replacement cannot be saved", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null, failWrites: false };
      const h = yield* makeHarness({ connected: false, storage });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      storage.failWrites = true;
      const replacement = yield* Effect.promise(() => h.commands.snooze.run(h.registry, snooze));
      expect(replacement._tag).toBe("Failure");
      expect(h.registry.get(pending).has(THREAD_ID)).toBe(true);
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("settled");
      expect(stored(storage)).toMatchObject([{ action: { type: "settle" } }]);
    }),
  );

  it.effect("keeps queued changes to their own environment", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      const other = EnvironmentId.make("other-remote");
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      expect(h.registry.get(h.commands.snapshotAtom(other))).toBe(SNAPSHOT);
      expect(h.registry.get(h.commands.pendingSyncAtom(other)).size).toBe(0);
    }),
  );

  it.effect("remembers which environments may triage offline across a cold restart", () =>
    Effect.gen(function* () {
      const writes = yield* Queue.unbounded<string>();
      const storage = { value: null as string | null, writes };
      const online = yield* makeHarness({ storage, operateScope: true });
      online.registry.mount(online.commands.offlineTriagePermittedAtom(ENVIRONMENT_ID));
      yield* Queue.take(writes);

      const coldOffline = yield* makeHarness({ connected: false, storage, operateScope: null });
      const permitted = coldOffline.commands.offlineTriagePermittedAtom(ENVIRONMENT_ID);
      coldOffline.registry.mount(permitted);
      yield* waitFor(coldOffline.registry, permitted, (value) => value);

      // A session that loads without the scope wins and is remembered for the next restart.
      coldOffline.registry.set(coldOffline.operateScopeAtom(ENVIRONMENT_ID), false);
      expect(coldOffline.registry.get(permitted)).toBe(false);
      yield* Queue.take(writes);
      const restarted = yield* makeHarness({ connected: false, storage, operateScope: null });
      const restartedPermitted = restarted.commands.offlineTriagePermittedAtom(ENVIRONMENT_ID);
      restarted.registry.mount(restartedPermitted);
      yield* Effect.promise(() =>
        restarted.commands.settle.run(restarted.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID },
        }),
      );
      expect(restarted.registry.get(restartedPermitted)).toBe(false);
    }),
  );

  it.effect("does not allow offline triage for an environment never seen with the scope", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false, operateScope: null });
      const permitted = h.commands.offlineTriagePermittedAtom(ENVIRONMENT_ID);
      h.registry.mount(permitted);
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      expect(h.registry.get(permitted)).toBe(false);
    }),
  );

  it.effect("keeps a queued settle when Undo cannot remove it from storage", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null, failWrites: false };
      const h = yield* makeHarness({ connected: false, storage });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      storage.failWrites = true;
      const undo = yield* Effect.promise(() =>
        h.commands.unsettle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, reason: "user" },
        }),
      );
      expect(undo._tag).toBe("Failure");
      expect(h.registry.get(pending).has(THREAD_ID)).toBe(true);
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("settled");

      storage.failWrites = false;
      const restarted = yield* makeHarness({ connected: false, storage });
      const restartedPending = restarted.commands.pendingSyncAtom(ENVIRONMENT_ID);
      restarted.registry.mount(restartedPending);
      yield* waitFor(restarted.registry, restartedPending, (threads) => threads.has(THREAD_ID));
    }),
  );

  it.effect("does not restore changes of an environment removed while they load", () =>
    Effect.gen(function* () {
      const writes = yield* Queue.unbounded<string>();
      const storage = { value: null as string | null, writes };
      const before = yield* makeHarness({ connected: false, storage, operateScope: true });
      before.registry.mount(before.commands.offlineTriagePermittedAtom(ENVIRONMENT_ID));
      yield* Effect.promise(() => before.commands.settle.run(before.registry, settle));
      expect(stored(storage)).toHaveLength(1);

      // The removal lands after the read but before the loaded document is published.
      // The session from before the removal is still loaded and still grants the scope.
      const h = yield* makeHarness({
        connected: false,
        storage,
        operateScope: true,
        registered: false,
        wrapStore: (store) => ({
          ...store,
          load: store.load.pipe(Effect.tap(() => store.clearEnvironment(ENVIRONMENT_ID))),
        }),
      });
      const laterThreadId = ThreadId.make("later-thread");
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
        ...SNAPSHOT,
        threads: [...SNAPSHOT.threads, { ...SNAPSHOT.threads[0]!, id: laterThreadId }],
      });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      const permitted = h.commands.offlineTriagePermittedAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      h.registry.mount(permitted);
      // Queueing another thread waits for the load to publish its document.
      yield* Effect.promise(() =>
        h.commands.settle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: laterThreadId },
        }),
      );
      expect([...h.registry.get(pending)]).toEqual([laterThreadId]);
      expect(stored(storage)).toMatchObject([{ threadId: laterThreadId }]);
      expect(h.registry.get(permitted)).toBe(false);
      expect(JSON.parse(storage.value!).operableEnvironmentIds).toEqual([]);
    }),
  );

  it.effect("does not let a retained session or an in-flight write restore a removed grant", () =>
    Effect.gen(function* () {
      const writes = yield* Queue.unbounded<string>();
      const storage = { value: null as string | null, writes };
      let removeBeforeWrite = true;
      let unregister = () => {};
      const h = yield* makeHarness({
        connected: false,
        storage,
        operateScope: true,
        // The removal lands while the grant's write waits for the store.
        wrapStore: (store) => ({
          ...store,
          setOperable: (environmentId, operable, stillCurrent) =>
            (removeBeforeWrite
              ? Effect.sync(() => {
                  removeBeforeWrite = false;
                  unregister();
                }).pipe(Effect.andThen(store.clearEnvironment(environmentId)))
              : Effect.void
            ).pipe(Effect.andThen(store.setOperable(environmentId, operable, stillCurrent))),
        }),
      });
      unregister = () => h.registry.set(h.registeredAtom(ENVIRONMENT_ID), false);
      const permitted = h.commands.offlineTriagePermittedAtom(ENVIRONMENT_ID);
      h.registry.mount(permitted);
      expect(JSON.parse(yield* Queue.take(writes)).operableEnvironmentIds).toEqual([]);
      expect(h.registry.get(permitted)).toBe(false);
      // The store runs writes in order, so this one follows the skipped grant.
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      expect(JSON.parse(yield* Queue.take(writes))).toMatchObject({
        entries: [{ threadId: THREAD_ID }],
        operableEnvironmentIds: [],
      });

      // Adding the environment again lets its session be remembered.
      h.registry.set(h.registeredAtom(ENVIRONMENT_ID), true);
      expect(h.registry.get(permitted)).toBe(true);
      expect(JSON.parse(yield* Queue.take(writes)).operableEnvironmentIds).toEqual([
        ENVIRONMENT_ID,
      ]);
    }),
  );

  it.effect("Undo after a queued settle was delivered un-settles on the server", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      const queued = yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      expect(queued._tag === "Success" && queued.value.pendingSync).toBe(true);
      yield* h.reconnect();
      const replay = yield* Queue.take(h.requests);
      yield* Deferred.succeed(replay.reply, { sequence: 2 });
      yield* waitFor(h.registry, pending, (threads) => threads.size === 0);

      const undo = h.commands.unsettle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, reason: "user" },
      });
      const request = yield* Queue.take(h.requests);
      expect(request.command.type).toBe("thread.unsettle");
      yield* Deferred.succeed(request.reply, { sequence: 3 });
      const result = yield* Effect.promise(() => undo);
      expect(result._tag === "Success" && ThreadUndo.cancelledPendingSync(result.value)).toBe(
        false,
      );
    }),
  );

  /** The request may have reached the server before the socket closed. */
  const lostReply = () =>
    new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "socket closed",
        cause: new Error("socket closed"),
      }),
    });

  it.effect("Undo after a replay lost its reply un-settles on the server", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      yield* h.reconnect();
      const replay = yield* Queue.take(h.requests);
      // Waits behind the replay, so its request shows the replay has let go of the thread.
      const behind = h.commands.unsnooze.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, reason: "user" },
      });
      yield* Deferred.fail(replay.reply, lostReply());
      const behindRequest = yield* Queue.take(h.requests);
      yield* Deferred.succeed(behindRequest.reply, { sequence: 2 });
      yield* Effect.promise(() => behind);
      expect(h.registry.get(pending).has(THREAD_ID)).toBe(true);

      const undo = h.commands.unsettle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, reason: "user" },
      });
      const sent = yield* Effect.raceFirst(
        Queue.take(h.requests),
        Effect.promise(() => undo).pipe(Effect.as("cancelled locally" as const)),
      );
      expect(sent).toMatchObject({ command: { type: "thread.unsettle" } });
      if (sent === "cancelled locally") return;
      yield* Deferred.succeed(sent.reply, { sequence: 3 });
      const result = yield* Effect.promise(() => undo);
      expect(result._tag === "Success" && ThreadUndo.cancelledPendingSync(result.value)).toBe(
        false,
      );
      expect(h.registry.get(pending).size).toBe(0);
      expect(stored(h.storage)).toEqual([]);
    }),
  );

  it.effect("queues the snapshot the action was taken against, not a later one", () =>
    Effect.gen(function* () {
      const loaded = yield* Deferred.make<void>();
      const h = yield* makeHarness({
        connected: false,
        wrapStore: (store) => ({
          ...store,
          load: Deferred.await(loaded).pipe(Effect.andThen(store.load)),
        }),
      });
      const queued = h.commands.settle.run(h.registry, settle);
      // The shell moves on while the queue waits for storage.
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
        ...SNAPSHOT,
        snapshotSequence: 5,
        threads: [{ ...SNAPSHOT.threads[0]!, title: "Renamed on the Mac" }],
      });
      yield* Deferred.succeed(loaded, undefined);
      expect((yield* Effect.promise(() => queued))._tag).toBe("Success");
      expect(stored(h.storage)).toMatchObject([{ snapshotSequence: 1 }]);
    }),
  );

  it.effect("does not remember a session that answers after its environment was removed", () =>
    Effect.gen(function* () {
      const writes = yield* Queue.unbounded<string>();
      const storage = { value: null as string | null, writes };
      const h = yield* makeHarness({ connected: false, storage, operateScope: null });
      const permitted = h.commands.offlineTriagePermittedAtom(ENVIRONMENT_ID);
      h.registry.mount(permitted);
      // Removed while its first session request is still waiting.
      h.registry.set(h.registeredAtom(ENVIRONMENT_ID), false);
      yield* h.store.clearEnvironment(ENVIRONMENT_ID);
      yield* Queue.take(writes);
      h.registry.set(h.operateScopeAtom(ENVIRONMENT_ID), true);
      expect(h.registry.get(permitted)).toBe(false);
      // The store runs writes in order, so this one follows any grant write.
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      expect(JSON.parse(yield* Queue.take(writes)).operableEnvironmentIds).toEqual([]);

      // Registering it again lets its session be remembered.
      h.registry.set(h.registeredAtom(ENVIRONMENT_ID), true);
      expect(h.registry.get(permitted)).toBe(true);
      expect(JSON.parse(yield* Queue.take(writes)).operableEnvironmentIds).toEqual([
        ENVIRONMENT_ID,
      ]);
    }),
  );

  it.effect("drops a queued change once a newer action reaches the server behind its replay", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      yield* h.reconnect();
      const replay = yield* Queue.take(h.requests);
      expect(replay.command.type).toBe("thread.settle");
      // Starts while the replay still holds the thread, so it waits behind it.
      const newer = h.commands.snooze.run(h.registry, snooze);
      yield* Deferred.fail(
        replay.reply,
        new EnvironmentRpcUnavailableError({
          environmentId: ENVIRONMENT_ID,
          message: "Mac is not connected.",
        }),
      );
      const request = yield* Queue.take(h.requests);
      expect(request.command.type).toBe("thread.snooze");
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      expect((yield* Effect.promise(() => newer))._tag).toBe("Success");
      expect(h.registry.get(pending).size).toBe(0);
      expect(stored(h.storage)).toEqual([]);
    }),
  );

  it.effect("keeps a change queued while a newer action was reaching the server", () =>
    Effect.gen(function* () {
      const putStarted = yield* Deferred.make<void>();
      const putReleased = yield* Deferred.make<void>();
      const h = yield* makeHarness({
        connected: false,
        wrapStore: (store) => ({
          ...store,
          put: (entry, stillCurrent) =>
            Deferred.succeed(putStarted, undefined).pipe(
              Effect.andThen(Deferred.await(putReleased)),
              Effect.andThen(store.put(entry, stillCurrent)),
            ),
        }),
      });
      const pending = h.commands.pendingSyncAtom(ENVIRONMENT_ID);
      h.registry.mount(pending);
      const queued = h.commands.settle.run(h.registry, settle);
      yield* Deferred.await(putStarted);
      yield* h.reconnect("synchronizing");
      const online = h.commands.snooze.run(h.registry, snooze);
      const request = yield* Queue.take(h.requests);
      // The queued change lands while the newer action is still on its way.
      yield* Deferred.succeed(putReleased, undefined);
      expect((yield* Effect.promise(() => queued))._tag).toBe("Success");
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      expect((yield* Effect.promise(() => online))._tag).toBe("Success");
      // The server decides on replay; the newer action must not erase it locally.
      expect(h.registry.get(pending).has(THREAD_ID)).toBe(true);
      expect(stored(h.storage)).toMatchObject([{ action: { type: "settle" } }]);
    }),
  );

  // Two browser tabs share one storage, but each keeps its own copy of the queue in memory.
  const otherTab = (storage: { value: string | null }) =>
    Effect.gen(function* () {
      const tab = yield* makeHarness({ connected: false, storage });
      const pending = tab.commands.pendingSyncAtom(ENVIRONMENT_ID);
      tab.registry.mount(pending);
      yield* waitFor(tab.registry, pending, (threads) => threads.has(THREAD_ID));
      return { tab, pending };
    });
  const sentOrDropped = (
    tab: Effect.Success<ReturnType<typeof makeHarness>>,
    pending: Atom.Atom<ReadonlySet<ThreadId>>,
  ) =>
    Effect.raceFirst(
      Queue.take(tab.requests).pipe(Effect.map((request) => request.command)),
      waitFor(tab.registry, pending, (threads) => threads.size === 0).pipe(
        Effect.as("dropped" as const),
      ),
    );

  it.effect("does not replay a change another tab cancelled", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const first = yield* makeHarness({ connected: false, storage });
      yield* Effect.promise(() => first.commands.settle.run(first.registry, settle));
      const { tab: second, pending } = yield* otherTab(storage);
      const undo = yield* Effect.promise(() =>
        first.commands.unsettle.run(first.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, reason: "user" },
        }),
      );
      expect(undo._tag).toBe("Success");
      yield* second.reconnect();
      expect(yield* sentOrDropped(second, pending)).toBe("dropped");
      expect(second.registry.get(second.visibleAtom)).toBe(SNAPSHOT);
    }),
  );

  it.effect("replays the change another tab queued in place of an older one", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const first = yield* makeHarness({ connected: false, storage });
      yield* Effect.promise(() => first.commands.snooze.run(first.registry, snooze));
      const { tab: second, pending } = yield* otherTab(storage);
      yield* Effect.promise(() => first.commands.settle.run(first.registry, settle));
      const [replacement] = stored(storage);
      yield* second.reconnect();
      expect(yield* sentOrDropped(second, pending)).toMatchObject({
        type: "thread.settle",
        commandId: replacement!.commandId,
      });
    }),
  );

  it.effect("does not replay when it cannot read the stored queue", () =>
    Effect.gen(function* () {
      const reads = yield* Queue.unbounded<void>();
      const storage = { value: null as string | null, failReads: false, reads };
      const first = yield* makeHarness({ connected: false, storage });
      yield* Effect.promise(() => first.commands.settle.run(first.registry, settle));
      const { tab: second, pending } = yield* otherTab(storage);
      yield* Queue.clear(reads);
      storage.failReads = true;
      yield* second.reconnect();
      yield* Queue.take(reads);
      // A second reconnect only replays after the first attempt finished.
      yield* second.disconnect;
      yield* second.reconnect();
      yield* Queue.take(reads);
      expect(yield* Queue.size(second.requests)).toBe(0);
      expect(second.registry.get(pending).has(THREAD_ID)).toBe(true);
    }),
  );

  const expireStoredSnooze = (storage: { value: string | null }) => {
    storage.value = storage.value!.replace("2099-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z");
  };

  it.effect("Undo asks the server once another tab has sent the queued change", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      h.registry.mount(h.commands.pendingSyncAtom(ENVIRONMENT_ID));
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      const { tab, pending } = yield* otherTab(h.storage);
      yield* tab.reconnect();
      const replay = yield* Queue.take(tab.requests);
      yield* Deferred.succeed(replay.reply, { sequence: 2 });
      yield* waitFor(tab.registry, pending, (threads) => threads.size === 0);

      // This tab is still offline, so the server Undo it needs cannot reach the server.
      const result = yield* Effect.promise(() =>
        h.commands.unsettle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, reason: "user" },
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect.each([
    ["settle", "unsettle"],
    ["snooze", "unsnooze"],
  ] as const)(
    "Undo after a restart or in another tab asks the server once a %s replay lost its reply",
    ([action, undo]) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ connected: false });
        h.registry.mount(h.commands.pendingSyncAtom(ENVIRONMENT_ID));
        yield* Effect.promise(() => h.commands[action].run(h.registry, snooze));
        yield* h.reconnect();
        const replay = yield* Queue.take(h.requests);
        yield* Deferred.fail(replay.reply, lostReply());
        const { tab } = yield* otherTab(h.storage);

        // Still offline here, so the server Undo it needs cannot reach the server.
        const result = yield* Effect.promise(() =>
          tab.commands[undo].run(tab.registry, {
            environmentId: ENVIRONMENT_ID,
            input: { threadId: THREAD_ID, reason: "user" },
          }),
        );
        expect(result._tag).toBe("Failure");
        expect(stored(h.storage)).toMatchObject([{ action: { type: action }, attempted: true }]);
      }),
  );

  it.effect("Undo asks the server for a change that replaced one whose reply was lost", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      h.registry.mount(h.commands.pendingSyncAtom(ENVIRONMENT_ID));
      yield* Effect.promise(() => h.commands.snooze.run(h.registry, snooze));
      yield* h.reconnect();
      const replay = yield* Queue.take(h.requests);
      yield* h.disconnect;
      yield* Deferred.fail(replay.reply, lostReply());
      const later = {
        ...snooze,
        input: { ...snooze.input, snoozedUntil: "2099-02-01T00:00:00.000Z" },
      };
      yield* Effect.promise(() => h.commands.snooze.run(h.registry, later));
      expect(stored(h.storage)).toMatchObject([
        { action: { type: "snooze", snoozedUntil: later.input.snoozedUntil }, attempted: true },
      ]);

      const result = yield* Effect.promise(() =>
        h.commands.unsnooze.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, reason: "user" },
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("does not send a queued change it cannot record as sent", () =>
    Effect.gen(function* () {
      const markFailed = yield* Deferred.make<void>();
      let failMark = true;
      const h = yield* makeHarness({
        connected: false,
        wrapStore: (store) => ({
          ...store,
          markAttempted: (key) =>
            failMark
              ? Deferred.succeed(markFailed, undefined).pipe(
                  Effect.andThen(
                    Effect.fail(new ThreadTriageOutboxStorageError({ cause: "disk full" })),
                  ),
                )
              : store.markAttempted(key),
        }),
      });
      yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      yield* h.reconnect();
      const first = yield* Effect.raceFirst(
        Deferred.await(markFailed).pipe(Effect.as("not sent" as const)),
        Queue.take(h.requests).pipe(Effect.as("sent" as const)),
      );
      expect(first).toBe("not sent");
      failMark = false;
      // A second reconnect only replays after the first attempt finished.
      yield* h.disconnect;
      yield* h.reconnect();
      const request = yield* Queue.take(h.requests);
      expect(request.command.type).toBe("thread.settle");
      expect(yield* Queue.size(h.requests)).toBe(0);
    }),
  );

  it.effect("judges expiry by the replacement another tab stored, not the cached change", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const first = yield* makeHarness({ connected: false, storage });
      yield* Effect.promise(() => first.commands.snooze.run(first.registry, snooze));
      expireStoredSnooze(storage);
      const { tab: second, pending } = yield* otherTab(storage);
      yield* Effect.promise(() => first.commands.settle.run(first.registry, settle));
      const [replacement] = stored(storage);
      yield* second.reconnect();
      expect(yield* sentOrDropped(second, pending)).toMatchObject({
        type: "thread.settle",
        commandId: replacement!.commandId,
      });
    }),
  );

  it.effect("drops a replacement another tab stored once its snooze expired", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const first = yield* makeHarness({ connected: false, storage });
      yield* Effect.promise(() => first.commands.snooze.run(first.registry, snooze));
      const { tab: second, pending } = yield* otherTab(storage);
      yield* Effect.promise(() => first.commands.snooze.run(first.registry, snooze));
      expireStoredSnooze(storage);
      yield* second.reconnect();
      expect(yield* sentOrDropped(second, pending)).toBe("dropped");
      expect(stored(storage)).toEqual([]);
    }),
  );
});
