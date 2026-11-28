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
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  makeThreadTriageOutboxStore,
  ThreadTriageOutboxStore,
} from "../platform/threadTriageOutboxStore.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { createThreadEnvironmentAtoms } from "./threadCommands.ts";
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
  readonly storage?: { value: string | null };
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
  const connectionFollowed = yield* Deferred.make<void>();
  const connection = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    phase: "connected",
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Test",
      connectionId: "test",
    }),
    state: connection,
    session,
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const storage = options?.storage ?? { value: null };
  const store = makeThreadTriageOutboxStore((next) =>
    Effect.sync(() => {
      storage.value = next(storage.value) ?? storage.value;
    }),
  );
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(
            stream,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisor,
          ).pipe(Stream.onStart(Deferred.succeed(connectionFollowed, undefined))),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        SecureRandom.SecureRandom,
        // Distinct per call, so a resend under a fresh command id would show.
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
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(SNAPSHOT),
  );
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
  return {
    registry,
    commands,
    snapshotAtom,
    statusAtom,
    visibleAtom,
    pendingSyncAtom,
    reconnect,
    store,
    requests,
    reconciled,
    connection,
    connectionFollowed,
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
      const history = yield* Effect.forkChild(
        Effect.exit(
          h.commands.loadEarlierHistory.run(h.registry, {
            environmentId: ENVIRONMENT_ID,
            input: { threadId: THREAD_ID },
          }),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(historyStarted);
      const send = yield* Effect.forkChild(
        Effect.exit(
          h.commands.startTurn.run(h.registry, {
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
          }),
        ),
        { startImmediately: true },
      );
      // Dispatched after Send on another thread, so it arrives first only if Send is queued.
      const controlThreadId = ThreadId.make("control-thread");
      const control = yield* Effect.forkChild(
        Effect.exit(
          h.commands.interruptTurn.run(h.registry, {
            environmentId: ENVIRONMENT_ID,
            input: { threadId: controlThreadId, runId: RunId.make("control-run") },
          }),
        ),
        { startImmediately: true },
      );
      const first = yield* Queue.take(h.requests);
      yield* Deferred.succeed(first.reply, { sequence: 1 });
      yield* Deferred.succeed(historyReply, { _tag: "loaded" });
      const second = yield* Queue.take(h.requests);
      yield* Deferred.succeed(second.reply, { sequence: 2 });
      const results = yield* Fiber.joinAll([history, send, control]);

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
      const result = yield* Effect.forkChild(
        Effect.exit(
          h.commands.interruptTurn.run(h.registry, {
            environmentId: ENVIRONMENT_ID,
            input: { threadId: THREAD_ID, runId: RunId.make("finished-run") },
          }),
        ),
        { startImmediately: true },
      );
      const request = yield* Queue.take(h.requests);
      expect(request.command.type).toBe("run.interrupt");
      yield* Deferred.fail(request.reply, new Error("Run is not interruptible"));
      expect((yield* Fiber.join(result))._tag).toBe("Failure");
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
    const result = yield* Effect.forkChild(
      Effect.exit(
        h.commands.interruptTurn.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, runId: RunId.make("running-run") },
        }),
      ),
      { startImmediately: true },
    );
    const request = yield* Queue.take(h.requests);
    yield* Deferred.succeed(request.reply, { sequence: 1 });
    yield* Deferred.await(asked);
    return { threadScope, result };
  });

  it.effect("resolves Stop without waiting for the pending work lookup", () =>
    Effect.gen(function* () {
      const { threadScope, result } = yield* stopWithBlockedLookup();
      expect((yield* Fiber.join(result))._tag).toBe("Success");
      yield* Scope.close(threadScope, Exit.void);
    }),
  );

  it.effect("keeps an accepted Stop when the thread closes during the lookup", () =>
    Effect.gen(function* () {
      const { threadScope, result } = yield* stopWithBlockedLookup();
      yield* Scope.close(threadScope, Exit.void);
      expect((yield* Fiber.join(result))._tag).toBe("Success");
    }),
  );
});

describe("title regeneration", () => {
  it.effect("resolves with the outcome recorded for its own request", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const source = h.snapshotAtom(ENVIRONMENT_ID);
      const thread = SNAPSHOT.threads[0]!;
      const target = { environmentId: ENVIRONMENT_ID, input: { threadId: THREAD_ID } };
      const earlier = {
        requestId: CommandId.make("earlier"),
        status: "renamed" as const,
        completedAt: NOW,
      };

      h.registry.set(source, null);
      const result = yield* Effect.forkChild(
        Effect.exit(h.commands.regenerateTitle.run(h.registry, target)),
        { startImmediately: true },
      );
      const request = yield* Queue.take(h.requests);
      const requestId = request.command.commandId;
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      yield* Deferred.await(h.connectionFollowed);
      h.registry.set(source, {
        ...SNAPSHOT,
        snapshotSequence: 2,
        threads: [
          {
            ...thread,
            titleRegeneration: { requestId, startedAt: NOW },
            lastTitleRegeneration: earlier,
          },
        ],
      });
      h.registry.set(source, {
        ...SNAPSHOT,
        snapshotSequence: 3,
        threads: [],
        archivedThreads: [
          {
            ...thread,
            archivedAt: NOW,
            titleRegeneration: null,
            lastTitleRegeneration: {
              requestId,
              status: "failed",
              message: "model unavailable",
              completedAt: NOW,
            },
          },
        ],
      });
      const outcome = yield* Fiber.join(result);
      expect(outcome).toMatchObject({
        _tag: "Success",
        value: { status: "failed", message: "model unavailable" },
      });

      const superseded = yield* Effect.forkChild(
        Effect.exit(h.commands.regenerateTitle.run(h.registry, target)),
        { startImmediately: true },
      );
      const second = yield* Queue.take(h.requests);
      h.registry.set(source, {
        ...SNAPSHOT,
        snapshotSequence: 4,
        threads: [{ ...thread, titleRegeneration: null, lastTitleRegeneration: earlier }],
      });
      yield* Deferred.succeed(second.reply, { sequence: 4 });
      expect(yield* Fiber.join(superseded)).toMatchObject({
        _tag: "Success",
        value: null,
      });
    }),
  );

  it.effect("settles without an outcome when the environment disconnects while waiting", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = yield* Effect.forkChild(
        Effect.exit(
          h.commands.regenerateTitle.run(h.registry, {
            environmentId: ENVIRONMENT_ID,
            input: { threadId: THREAD_ID },
          }),
        ),
        { startImmediately: true },
      );
      const request = yield* Queue.take(h.requests);
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      yield* SubscriptionRef.update(h.connection, (state) => ({
        ...state,
        phase: "backoff" as const,
      }));
      expect(yield* Fiber.join(result)).toMatchObject({ _tag: "Success", value: null });
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
        const result = yield* Effect.forkChild(
          Effect.exit(
            h.commands[action].run(h.registry, {
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
            }),
          ),
          { startImmediately: true },
        );
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(expected);
        const request = yield* Queue.take(h.requests);
        expect(h.registry.get(source)).toBe(initial);
        yield* Deferred.fail(request.reply, new Error("Remote rejected the action"));
        expect((yield* Fiber.join(result))._tag).toBe("Failure");
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
      const result = yield* Effect.forkChild(
        Effect.exit(
          h.commands.snooze.run(h.registry, {
            environmentId: ENVIRONMENT_ID,
            input: { threadId: THREAD_ID, snoozedUntil: DateTime.formatIso(FUTURE) },
          }),
        ),
        { startImmediately: true },
      );
      const snoozedAt = h.registry.get(h.visibleAtom)?.threads[0]?.snoozedAt;
      expect(DateTime.toEpochMillis(snoozedAt!)).toBeGreaterThan(
        DateTime.toEpochMillis(earlierSnoozedAt),
      );
      const request = yield* Queue.take(h.requests);
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      expect((yield* Fiber.join(result))._tag).toBe("Success");
    }),
  );

  it.effect("keeps the preview after acknowledgement until the matching shell update arrives", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = yield* Effect.forkChild(
        Effect.exit(
          h.commands.settle.run(h.registry, {
            environmentId: ENVIRONMENT_ID,
            input: { threadId: THREAD_ID },
          }),
        ),
        { startImmediately: true },
      );
      const request = yield* Queue.take(h.requests);
      yield* Deferred.succeed(request.reply, { sequence: 3 });
      expect((yield* Fiber.join(result))._tag).toBe("Success");
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
        const settle = yield* Effect.forkChild(
          Effect.exit(
            h.commands.settle.run(h.registry, {
              environmentId: ENVIRONMENT_ID,
              input: { threadId: THREAD_ID },
            }),
          ),
          { startImmediately: true },
        );
        const first = yield* Queue.take(h.requests);
        const unsettle = yield* Effect.forkChild(
          Effect.exit(
            h.commands.unsettle.run(h.registry, {
              environmentId: ENVIRONMENT_ID,
              input: { threadId: THREAD_ID, reason: "user" },
            }),
          ),
          { startImmediately: true },
        );
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("active");
        yield* Deferred.fail(first.reply, new Error("Settle rejected"));
        yield* Fiber.join(settle);
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
        yield* Fiber.join(unsettle);
        expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      }),
  );

  it.effect("isolates environments and does not restore a remotely removed thread", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const otherEnvironment = EnvironmentId.make("other-remote");
      const result = yield* Effect.forkChild(
        Effect.exit(
          h.commands.settle.run(h.registry, {
            environmentId: ENVIRONMENT_ID,
            input: { threadId: THREAD_ID },
          }),
        ),
        { startImmediately: true },
      );
      const request = yield* Queue.take(h.requests);
      expect(h.registry.get(h.commands.snapshotAtom(otherEnvironment))).toBe(SNAPSHOT);
      expect(h.registry.get(h.commands.rowActionsAtom(ENVIRONMENT_ID))).toBe(1);
      expect(h.registry.get(h.commands.rowActionsAtom(otherEnvironment))).toBe(0);
      const removed = { ...SNAPSHOT, snapshotSequence: 2, threads: [] };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), removed);
      expect(h.registry.get(h.visibleAtom)?.threads).toEqual([]);
      yield* Deferred.fail(request.reply, new Error("Thread removed"));
      yield* Fiber.join(result);
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
      const result = yield* Effect.forkChild(
        Effect.exit(
          h.commands[action].run(h.registry, {
            environmentId: ENVIRONMENT_ID,
            input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
          }),
        ),
        { startImmediately: true },
      );
      const first = yield* Queue.take(h.requests);
      const undo = yield* Effect.forkChild(
        Effect.exit(
          h.commands[action === "settle" ? "unsettle" : "unsnooze"].run(h.registry, {
            environmentId: ENVIRONMENT_ID,
            input: { threadId: THREAD_ID, reason: "user" },
          }),
        ),
        { startImmediately: true },
      );
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
      yield* Deferred.succeed(first.reply, { sequence: 2 });
      expect((yield* Fiber.join(result))._tag).toBe("Success");
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
      expect((yield* Fiber.join(undo))._tag).toBe("Failure");
      expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
    }),
  );

  it.effect.each(undoableActions)(
    "preserves a newer approval when the %s reply arrives after the shell",
    (action) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const result = yield* Effect.forkChild(
          Effect.exit(
            h.commands[action].run(h.registry, {
              environmentId: ENVIRONMENT_ID,
              input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
            }),
          ),
          { startImmediately: true },
        );
        const request = yield* Queue.take(h.requests);
        const newer = {
          ...SNAPSHOT,
          snapshotSequence: 3,
          threads: [{ ...SNAPSHOT.threads[0]!, pendingRuntimeRequest: APPROVAL }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), newer);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(newer.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Fiber.join(result))._tag).toBe("Success");
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
        const result = yield* Effect.forkChild(
          Effect.exit(
            h.commands[action].run(h.registry, {
              environmentId: ENVIRONMENT_ID,
              input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
            }),
          ),
          { startImmediately: true },
        );
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
        expect((yield* Fiber.join(result))._tag).toBe("Success");
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
      const result = yield* Effect.forkChild(
        Effect.exit(
          h.commands.snooze.run(h.registry, {
            environmentId: ENVIRONMENT_ID,
            input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
          }),
        ),
        { startImmediately: true },
      );
      const request = yield* Queue.take(h.requests);
      const snoozed = h.registry.get(h.visibleAtom)?.threads[0];
      expect(DateTime.toEpochMillis(snoozed!.snoozedAt!)).toBeGreaterThanOrEqual(
        DateTime.toEpochMillis(USER_INPUT.createdAt),
      );
      expect(snoozed?.pendingRuntimeRequest).toEqual(USER_INPUT);
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      expect((yield* Fiber.join(result))._tag).toBe("Success");
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

// regression: #24532 settle and snooze while the thread's machine is offline
describe("settle and snooze while the environment is offline", () => {
  type Harness = Effect.Success<ReturnType<typeof makeHarness>>;
  const target = { environmentId: ENVIRONMENT_ID, input: { threadId: THREAD_ID } };
  const snooze = {
    environmentId: ENVIRONMENT_ID,
    input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
  };
  const undo = {
    environmentId: ENVIRONMENT_ID,
    input: { threadId: THREAD_ID, reason: "user" as const },
  };
  const queued = (h: Harness) => h.store.update((stored) => stored);
  const nothingPending = (h: Harness) =>
    waitFor(h.registry, h.pendingSyncAtom, (threads) => threads.size === 0);
  /** Commands on one thread go out in order, so this one arrives first only if no other was sent. */
  const expectNothingSent = Effect.fn("expectNothingSent")(function* (h: Harness) {
    const pin = yield* Effect.forkChild(
      h.commands.pin.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, orderKey: "a" },
      }),
      { startImmediately: true },
    );
    const request = yield* Queue.take(h.requests);
    expect(request.command.type).toBe("thread.pin");
    yield* Deferred.succeed(request.reply, { sequence: 9 });
    yield* Fiber.join(pin);
  });

  it.effect.each([
    ["settle", { settledOverride: "settled" }],
    ["snooze", { snoozedUntil: FUTURE }],
  ] as const)("shows a %s at once and sends it once the shell is live", ([action, shown]) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      const run =
        action === "settle"
          ? h.commands.settle.run(h.registry, target)
          : h.commands.snooze.run(h.registry, snooze);
      expect(Exit.isSuccess(yield* Effect.exit(run))).toBe(true);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(shown);
      expect([...h.registry.get(h.pendingSyncAtom)]).toEqual([THREAD_ID]);
      const entries = yield* queued(h);
      expect(entries).toHaveLength(1);

      yield* h.reconnect();
      const request = yield* Queue.take(h.requests);
      expect(request.command).toMatchObject({
        type: `thread.${action}`,
        threadId: THREAD_ID,
        commandId: entries[0]!.commandId,
      });
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      yield* nothingPending(h);
      expect(yield* queued(h)).toEqual([]);
      yield* expectNothingSent(h);
    }),
  );

  it.effect("drops a queued settle when the thread changed on the server meanwhile", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      yield* Effect.exit(h.commands.settle.run(h.registry, target));
      yield* h.reconnect("synchronizing");
      const changed = {
        ...SNAPSHOT,
        snapshotSequence: 5,
        threads: [
          {
            ...SNAPSHOT.threads[0]!,
            latestRunId: RunId.make("run-2"),
            itemCount: 3,
          },
        ],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), changed);
      h.registry.set(h.statusAtom(ENVIRONMENT_ID), "live");
      yield* nothingPending(h);
      expect(yield* queued(h)).toEqual([]);
      expect(h.registry.get(h.visibleAtom)).toBe(changed);
      yield* expectNothingSent(h);
    }),
  );

  it.effect("un-settling a queued settle cancels it without contacting the server", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      yield* Effect.exit(h.commands.settle.run(h.registry, target));
      // The undo plan stops here: the server never cleared the placement or snooze.
      expect(yield* h.commands.unsettle.run(h.registry, undo)).toMatchObject({
        cancelledOnDevice: true,
      });
      expect(h.registry.get(h.pendingSyncAtom).size).toBe(0);
      expect(yield* queued(h)).toEqual([]);
      expect(h.registry.get(h.visibleAtom)).toBe(SNAPSHOT);
      yield* h.reconnect();
      yield* expectNothingSent(h);
    }),
  );

  it.effect("waking cancels the snooze stored now, also when another tab replaced it", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const h = yield* makeHarness({ connected: false, storage });
      const otherTab = yield* makeHarness({ connected: false, storage });
      yield* Effect.exit(h.commands.snooze.run(h.registry, snooze));
      yield* Effect.exit(
        otherTab.commands.snooze.run(otherTab.registry, {
          ...snooze,
          input: { ...snooze.input, snoozedUntil: "2099-02-01T00:00:00.000Z" },
        }),
      );
      yield* h.commands.unsnooze.run(h.registry, undo);
      expect(yield* queued(h)).toEqual([]);
    }),
  );

  it.effect("skips a change another tab cancelled while an earlier send failed", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const h = yield* makeHarness({ connected: false, storage });
      const otherTab = yield* makeHarness({ connected: false, storage });
      const second = { ...SNAPSHOT.threads[0]!, id: ThreadId.make("second") };
      const twoThreads = { ...SNAPSHOT, threads: [SNAPSHOT.threads[0]!, second] };
      for (const tab of [h, otherTab])
        tab.registry.set(tab.snapshotAtom(ENVIRONMENT_ID), twoThreads);
      const settleSecond = { environmentId: ENVIRONMENT_ID, input: { threadId: second.id } };
      yield* Effect.exit(h.commands.settle.run(h.registry, target));
      yield* Effect.exit(h.commands.settle.run(h.registry, settleSecond));

      yield* h.reconnect();
      const first = yield* Queue.take(h.requests);
      yield* otherTab.commands.unsettle.run(otherTab.registry, {
        ...settleSecond,
        input: { ...settleSecond.input, reason: "user" as const },
      });
      yield* Deferred.fail(
        first.reply,
        new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1006 }) }),
      );
      // The replay re-reads storage before the next change, which drops the cancelled one.
      yield* waitFor(h.registry, h.pendingSyncAtom, (threads) => !threads.has(second.id));
      yield* expectNothingSent(h);
    }),
  );

  it.effect("sends a settle queued before a restart", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const before = yield* makeHarness({ connected: false, storage });
      yield* Effect.exit(before.commands.settle.run(before.registry, target));
      const [entry] = yield* queued(before);

      const h = yield* makeHarness({ connected: false, storage });
      yield* waitFor(h.registry, h.pendingSyncAtom, (threads) => threads.has(THREAD_ID));
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("settled");
      yield* h.reconnect();
      const request = yield* Queue.take(h.requests);
      expect(request.command).toMatchObject({
        type: "thread.settle",
        commandId: entry!.commandId,
      });
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      yield* nothingPending(h);
    }),
  );

  it.effect("refuses a snooze while a settle is queued, keeping the settle", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: false });
      yield* Effect.exit(h.commands.settle.run(h.registry, target));
      const before = yield* queued(h);
      const result = yield* Effect.exit(h.commands.snooze.run(h.registry, snooze));
      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({
        _tag: "EnvironmentRpcUnavailableError",
        message: "Test is not connected.",
      });
      expect(yield* queued(h)).toEqual(before);
    }),
  );
});
