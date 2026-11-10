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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import { BearerConnectionTarget } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  makeThreadTriageOutboxStore,
  ThreadTriageOutboxStorageError,
  ThreadTriageOutboxStore,
} from "../platform/threadTriageOutboxStore.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { createThreadEnvironmentAtoms } from "./threadCommands.ts";
import * as ThreadUndo from "./threadUndo.ts";
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
  /** Shared between harnesses to stand in for a restart. */
  readonly storage?: { value: string | null; failWrites?: boolean; onModify?: () => void };
}) {
  const requests = yield* Queue.unbounded<{
    command: OrchestrationV2Command;
    reply: Deferred.Deferred<{ sequence: number }, Error>;
  }>();
  const reconciled = yield* Queue.unbounded<ThreadId>();
  const liveSession = Option.some({
    client: {
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<{ sequence: number }, Error>();
          yield* Queue.offer(requests, { command, reply });
          return yield* Deferred.await(reply);
        }),
    },
  } as unknown as RpcSession);
  const session = yield* SubscriptionRef.make(
    options?.connected === false ? Option.none<RpcSession>() : liveSession,
  );
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Mac",
      connectionId: "test",
    }),
    session,
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const storage = options?.storage ?? { value: null };
  const store = makeThreadTriageOutboxStore((next) =>
    Effect.suspend(() => {
      storage.onModify?.();
      const value = next(storage.value);
      if (value === null) return Effect.void;
      if (storage.failWrites) {
        return Effect.fail(new ThreadTriageOutboxStorageError({ cause: "disk full" }));
      }
      storage.value = value;
      return Effect.void;
    }),
  );
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        SecureRandom.SecureRandom,
        // Distinct bytes per call, so each queued change gets its own command id.
        SecureRandom.make((size) => new Uint8Array(size).fill(++randomCalls % 256)),
      ),
      Layer.succeed(ThreadTriageOutboxStore, store),
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
  const commands = createThreadEnvironmentAtoms(runtime, snapshotAtom, statusAtom);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const visibleAtom = commands.snapshotAtom(ENVIRONMENT_ID);
  registry.mount(visibleAtom);
  const pendingSyncAtom = commands.pendingSyncAtom(ENVIRONMENT_ID);
  registry.mount(pendingSyncAtom);
  const reconnect = (status: EnvironmentShellStatus = "live") =>
    SubscriptionRef.set(session, liveSession).pipe(
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
    visibleAtom,
    pendingSyncAtom,
    requests,
    reconciled,
    storage,
    store,
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
        expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
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
        if (action === "settle") {
          expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(stale.threads[0]);
        } else {
          expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject({
            snoozedUntil: FUTURE,
            pendingRuntimeRequest: USER_INPUT,
          });
        }
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(
          action === "settle" ? { settledOverride: "settled" } : { snoozedUntil: FUTURE },
        );
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.pendingRuntimeRequest).toEqual(
          action === "settle" ? null : USER_INPUT,
        );
        expect(h.registry.get(h.snapshotAtom(ENVIRONMENT_ID))).toBe(stale);
      }),
  );
  it.effect("acknowledges a new question when snoozing again to the same wake time", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const initial = {
        ...SNAPSHOT,
        threads: [
          {
            ...SNAPSHOT.threads[0]!,
            pendingRuntimeRequest: USER_INPUT,
            snoozedAt: DateTime.makeUnsafe("2026-09-12T09:00:00.000Z"),
            snoozedUntil: FUTURE,
          },
        ],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), initial);
      const result = h.commands.snooze.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
      });
      const request = yield* Queue.take(h.requests);
      const snoozed = h.registry.get(h.visibleAtom)?.threads[0];
      expect(DateTime.toEpochMillis(snoozed!.snoozedAt!)).toBeGreaterThanOrEqual(
        DateTime.toEpochMillis(USER_INPUT.createdAt),
      );
      expect(snoozed?.pendingRuntimeRequest).toEqual(USER_INPUT);
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
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
  const undo = {
    environmentId: ENVIRONMENT_ID,
    input: { threadId: THREAD_ID, reason: "user" as const },
  };
  const stored = (storage: { value: string | null }) =>
    storage.value === null
      ? []
      : (JSON.parse(storage.value) as { entries: Array<Record<string, unknown>> }).entries;
  const changedThread = (change: Partial<OrchestrationV2ShellSnapshot["threads"][number]>) => ({
    ...SNAPSHOT,
    snapshotSequence: 5,
    threads: [{ ...SNAPSHOT.threads[0]!, ...change }],
  });
  /** The request may have reached the server before the socket closed. */
  const lostReply = () =>
    new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "socket closed",
        cause: new Error("socket closed"),
      }),
    });
  const queued = Effect.fn("queued")(function* (
    action: "settle" | "snooze" = "settle",
    storage?: { value: string | null; onModify?: () => void },
  ) {
    const h = yield* makeHarness({ connected: false, ...(storage ? { storage } : {}) });
    const result = yield* Effect.promise(() => h.commands[action].run(h.registry, snooze));
    expect(result._tag).toBe("Success");
    return h;
  });
  type Harness = Effect.Success<ReturnType<typeof makeHarness>>;
  const nothingPending = (h: Harness) =>
    waitFor(h.registry, h.pendingSyncAtom, (threads) => threads.size === 0);
  /** Commands on one thread go out in order, so this one arrives first only if no other was sent. */
  const expectNothingSent = Effect.fn("expectNothingSent")(function* (h: Harness) {
    const pin = h.commands.pin.run(h.registry, settle);
    const request = yield* Queue.take(h.requests);
    expect(request.command.type).toBe("thread.pin");
    yield* Deferred.succeed(request.reply, { sequence: 1 });
    yield* Effect.promise(() => pin);
  });

  it.effect("shows a settle at once and sends it when the environment is back", () =>
    Effect.gen(function* () {
      const h = yield* queued();
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("settled");
      expect(h.registry.get(h.pendingSyncAtom).has(THREAD_ID)).toBe(true);
      const [entry] = stored(h.storage);
      expect(entry).toMatchObject({ threadId: THREAD_ID, action: { type: "settle" } });

      yield* h.reconnect();
      const request = yield* Queue.take(h.requests);
      expect(request.command).toMatchObject({
        type: "thread.settle",
        commandId: entry!.commandId,
        threadId: THREAD_ID,
      });
      // Recorded before the send, so a restart or Undo from here asks the server.
      expect(stored(h.storage)[0]!.attempted).toBe(true);
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      yield* nothingPending(h);
      expect(stored(h.storage)).toEqual([]);
    }),
  );

  it.effect("sends a queued snooze after a restart, under the command id it was stored with", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      yield* queued("snooze", storage);
      const [entry] = stored(storage);

      const restarted = yield* makeHarness({ connected: false, storage });
      yield* waitFor(
        restarted.registry,
        restarted.pendingSyncAtom,
        (threads) => threads.size === 1,
      );
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
      yield* nothingPending(restarted);
      yield* expectNothingSent(restarted);
    }),
  );

  it.effect.each([
    ["produced new output", { itemCount: 1 }],
    ["started a run", { latestRunId: RunId.make("later-run") }],
    ["was pinned on another device", { pinnedAt: NOW }],
    ["was settled and un-settled on another device", { unsettledAt: NOW }],
    ["was settled on another device", { settledOverride: "settled" as const, settledAt: NOW }],
    ["is asking for approval", { pendingRuntimeRequest: APPROVAL }],
  ] as const)("keeps the server's state for a thread that %s meanwhile", ([, change]) =>
    Effect.gen(function* () {
      const h = yield* queued();
      // Judged against the synchronized shell: sending any earlier would leave it pending here.
      yield* h.reconnect("synchronizing");
      const changed = changedThread(change);
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), changed);
      h.registry.set(h.statusAtom(ENVIRONMENT_ID), "live");
      yield* nothingPending(h);
      yield* expectNothingSent(h);
      expect(stored(h.storage)).toEqual([]);
      expect(h.registry.get(h.visibleAtom)).toBe(changed);
    }),
  );

  it.effect.each([
    // A reconnect whose shell has not synchronized yet lands while the change is being marked.
    { when: "the shell stops being synchronized while it is marked", connected: true },
    // The shell reports synchronized from a stale stream while the session is already gone.
    { when: "its environment has no session", connected: false },
  ])("leaves a change unsent and cancellable when $when", ({ connected }) =>
    Effect.gen(function* () {
      const unmarked = yield* Queue.unbounded<void>();
      const storage: { value: string | null; onModify?: () => void } = { value: null };
      const h = yield* queued("settle", storage);
      let calls = 0;
      // Replay reads the queue, marks the change, and takes the mark off again.
      storage.onModify = () => {
        calls += 1;
        if (calls === 2 && connected) {
          h.registry.set(h.statusAtom(ENVIRONMENT_ID), "synchronizing");
        }
        if (calls === 3) Queue.offerUnsafe(unmarked, undefined);
      };
      if (connected) yield* h.reconnect();
      else h.registry.set(h.statusAtom(ENVIRONMENT_ID), "live");
      yield* Queue.take(unmarked);
      const result = yield* Effect.promise(() => h.commands.unsettle.run(h.registry, undo));
      expect(result._tag === "Success" && ThreadUndo.cancelledPendingSync(result.value)).toBe(true);
      expect(stored(storage)).toEqual([]);
      yield* h.reconnect();
      yield* expectNothingSent(h);
    }),
  );

  it.effect("sends a change another tab queued after this tab loaded", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const other = yield* makeHarness({ connected: false, storage });
      // Store calls run in order, so the other tab's first read is done after this one.
      yield* other.store.update((entries) => entries);
      yield* queued("settle", storage);
      yield* other.reconnect();
      const request = yield* Queue.take(other.requests);
      expect(request.command).toMatchObject({
        type: "thread.settle",
        commandId: stored(storage)[0]!.commandId,
      });
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      yield* nothingPending(other);
    }),
  );

  it.effect("sends a queued change again when the first send got no answer", () =>
    Effect.gen(function* () {
      const h = yield* queued();
      yield* h.reconnect();
      const first = yield* Queue.take(h.requests);
      yield* h.disconnect;
      yield* Deferred.fail(first.reply, lostReply());
      expect(h.registry.get(h.pendingSyncAtom).has(THREAD_ID)).toBe(true);
      yield* h.reconnect();
      const second = yield* Queue.take(h.requests);
      expect(second.command.commandId).toBe(first.command.commandId);
      yield* Deferred.succeed(second.reply, { sequence: 2 });
      yield* nothingPending(h);
    }),
  );

  it.effect("drops a queued change the server refuses, and shows the server's state", () =>
    Effect.gen(function* () {
      const h = yield* queued();
      yield* h.reconnect();
      const request = yield* Queue.take(h.requests);
      yield* Deferred.fail(request.reply, new Error("This session cannot change threads."));
      yield* nothingPending(h);
      expect(stored(h.storage)).toEqual([]);
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
    }),
  );

  it.effect.each([
    ["settle", "unsettle"],
    ["snooze", "unsnooze"],
  ] as const)("undoing a queued %s cancels it without contacting the server", ([action, undoing]) =>
    Effect.gen(function* () {
      const h = yield* queued(action);
      const result = yield* Effect.promise(() => h.commands[undoing].run(h.registry, undo));
      expect(result._tag === "Success" && ThreadUndo.cancelledPendingSync(result.value)).toBe(true);
      expect(h.registry.get(h.pendingSyncAtom).size).toBe(0);
      expect(stored(h.storage)).toEqual([]);
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
      yield* h.reconnect();
      yield* expectNothingSent(h);
    }),
  );

  it.effect("after a lost reply, Undo asks the server and the change is not sent twice", () =>
    Effect.gen(function* () {
      const h = yield* queued();
      yield* h.reconnect();
      const request = yield* Queue.take(h.requests);
      yield* h.disconnect;
      yield* Deferred.fail(request.reply, lostReply());

      // The server may have settled it, so cancelling on the device would lose the Undo.
      const undone = yield* Effect.promise(() => h.commands.unsettle.run(h.registry, undo));
      expect(undone._tag).toBe("Failure");
      expect(h.registry.get(h.pendingSyncAtom).has(THREAD_ID)).toBe(true);

      // It had: the returning shell shows the thread settled, which answers the queued change.
      h.registry.set(
        h.snapshotAtom(ENVIRONMENT_ID),
        changedThread({ settledOverride: "settled", settledAt: NOW }),
      );
      yield* h.reconnect();
      yield* nothingPending(h);
      yield* expectNothingSent(h);
    }),
  );

  it.effect("a later action that reaches the server replaces the queued one", () =>
    Effect.gen(function* () {
      const h = yield* queued();
      yield* h.reconnect("synchronizing");
      const result = h.commands.snooze.run(h.registry, snooze);
      const request = yield* Queue.take(h.requests);
      expect(request.command.type).toBe("thread.snooze");
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
      expect(stored(h.storage)).toEqual([]);
      h.registry.set(h.statusAtom(ENVIRONMENT_ID), "live");
      yield* expectNothingSent(h);
    }),
  );

  it.effect("drops a queued snooze that expired before the reconnect", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      yield* queued("snooze", storage);
      storage.value = storage.value!.replace(
        "2099-01-01T00:00:00.000Z",
        "2000-01-01T00:00:00.000Z",
      );
      const restarted = yield* makeHarness({ connected: false, storage });
      yield* waitFor(
        restarted.registry,
        restarted.pendingSyncAtom,
        (threads) => threads.size === 1,
      );
      yield* restarted.reconnect();
      yield* nothingPending(restarted);
      yield* expectNothingSent(restarted);
      expect(stored(storage)).toEqual([]);
    }),
  );

  it.effect("sends what storage holds when another tab replaced the change", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const first = yield* queued("settle", storage);
      const second = yield* makeHarness({ connected: false, storage });
      yield* waitFor(second.registry, second.pendingSyncAtom, (threads) => threads.size === 1);
      yield* Effect.promise(() => second.commands.unsettle.run(second.registry, undo));
      yield* Effect.promise(() => second.commands.snooze.run(second.registry, snooze));

      yield* first.reconnect();
      const request = yield* Queue.take(first.requests);
      expect(request.command).toMatchObject({
        type: "thread.snooze",
        commandId: stored(storage)[0]!.commandId,
      });
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      yield* nothingPending(first);
    }),
  );

  it.effect("forgets a removed environment's queued changes", () =>
    Effect.gen(function* () {
      const h = yield* queued();
      yield* h.store.clearEnvironment(ENVIRONMENT_ID);
      yield* h.reconnect();
      yield* nothingPending(h);
      yield* expectNothingSent(h);
    }),
  );

  it.effect("does not queue a settle the cached thread cannot take", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), changedThread({ status: "running" }));
      const result = yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      expect(result._tag).toBe("Failure");
      expect(stored(h.storage)).toEqual([]);
    }),
  );

  // The other tab loaded before the settle was queued, so only storage knows about it.
  it.effect.each(["this tab", "another tab"] as const)(
    "keeps a settle queued in %s when a snooze of the same thread would replace it",
    (tab) =>
      Effect.gen(function* () {
        const storage = { value: null as string | null };
        const other = yield* makeHarness({ connected: false, storage });
        // Store calls run in order, so the other tab's first read is done after this one.
        yield* other.store.update((stored) => stored);
        const h = yield* queued("settle", storage);
        const before = storage.value;
        const snoozing = tab === "this tab" ? h : other;
        const result = yield* Effect.promise(() =>
          snoozing.commands.snooze.run(snoozing.registry, snooze),
        );
        expect(result._tag).toBe("Failure");
        expect(storage.value).toBe(before);
      }),
  );

  it.effect("keeps the not-connected failure when the change cannot be saved", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        connected: false,
        storage: { value: null, failWrites: true },
      });
      const result = yield* Effect.promise(() => h.commands.settle.run(h.registry, settle));
      expect(String(result._tag === "Failure" ? Cause.squash(result.cause) : "")).toContain(
        "Mac is not connected.",
      );
      expect(h.registry.get(h.pendingSyncAtom).size).toBe(0);
    }),
  );
});
