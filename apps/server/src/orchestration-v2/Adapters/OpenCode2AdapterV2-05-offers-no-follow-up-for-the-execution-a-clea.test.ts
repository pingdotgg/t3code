// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as NodeURL from "node:url";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  ChatFileAttachment,
  ChatImageAttachment,
  CheckpointId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import { TestClock } from "effect/testing";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  OPENCODE_2_STILL_STOPPING,
  OPENCODE_PROVIDER,
  t3McpServerName,
} from "@t3tools/provider-opencode/testing";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { openCode2ReplayRuntime } from "./OpenCode2AdapterV2.testkit.ts";
import {
  makeProviderReplayGate,
  type ProviderReplayGate,
} from "@t3tools/provider-testing/replayGate";

import {
  SESSION,
  threadId,
  out,
  reply,
  replyData,
  event,
  sessionInfo,
  promptAccepted,
  noOpenRequests,
  opening,
  bigPickle,
  policy,
  providerThread,
  turnInput,
  resumed,
  terminalOf,
  stopTimedOut,
  secondTurn,
  stopFirstTurn,
  terminals,
  continued,
  continuedHistory,
  providerTurnId,
} from "./OpenCode2AdapterV2-fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 adapter", (it) => {
  it.effect("offers no follow-up for the execution a cleared revert starts", () =>
    Effect.gen(function* () {
      const kept = "msg_t3_turn_run-attempt:kept:1";
      const dropped = "msg_t3_turn_run-attempt:dropped:1";
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const { runtime, thread } = yield* resumed([
        out("message.list", "<any>"),
        reply("message.list", {
          data: [
            { id: dropped, time: { created: 2 }, text: "second", type: "user" },
            { id: kept, time: { created: 1 }, text: "first", type: "user" },
          ],
          cursor: {},
        }),
        out("session.revert.stage", { sessionID: SESSION, messageID: dropped, files: false }),
        replyData("session.revert.stage", { messageID: dropped, files: [] }),
        out("session.revert.commit", { sessionID: SESSION }),
        reply("session.revert.commit", {
          status: 500,
          body: { _tag: "UnknownError", message: "disk I/O error" },
        }),
        // Uncleared stages commit on the next prompt; clearing triggers an empty execution without a T3 turn.
        out("session.revert.clear", { sessionID: SESSION }),
        reply("session.revert.clear", null),
        event("session.revert.cleared", { sessionID: SESSION }),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Effect.sync(() => void offers.push(request)),
          take: Effect.never,
        }),
      );
      const now = yield* DateTime.now;
      const turn = (attempt: string, ordinal: number) => ({
        id: ProviderTurnId.make(`provider-turn:${attempt}`),
        providerThreadId: thread.id,
        nodeId: NodeId.make(`node:${attempt}`),
        runAttemptId: RunAttemptId.make(`run-attempt:${attempt}:1`),
        nativeTurnRef: {
          driver: OPENCODE_PROVIDER,
          nativeId: `msg_t3_turn_run-attempt:${attempt}:1`,
          strength: "weak" as const,
        },
        ordinal,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      });
      const rollback = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:kept"),
            appRunOrdinal: 1,
            providerTurn: turn("kept", 1),
          },
          providerThreadTurns: [turn("kept", 1), turn("dropped", 2)],
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(rollback));
      assert.lengthOf(offers, 0);
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
    }).pipe(Effect.scoped),
  );
  it.effect("prompts under ids no other session on the server can hold", () =>
    Effect.gen(function* () {
      // Separate databases can repeat prompt ids on one server; OpenCode rejects cross-session duplicates with 409.
      const OTHER = "ses_f148ca2deffeOtherSession000";
      const steerInto = (session: string, recorded: string): ReadonlyArray<ProviderReplayEntry> => [
        out("session.prompt", {
          sessionID: session,
          id: recorded,
          text: "<any>",
          delivery: "steer",
        }),
        replyData("session.prompt", {
          id: recorded,
          sessionID: session,
          time: { created: 1790656601500 },
          type: "user",
          payload: { text: "Also say STEERED." },
          delivery: "steer",
        }),
        event("session.inbox.delivered", { sessionID: session, inboxID: recorded }),
        event("session.execution.succeeded", { sessionID: session }),
      ];
      const promptInto = (
        session: string,
        recorded: string,
      ): ReadonlyArray<ProviderReplayEntry> => [
        out("session.prompt", { sessionID: session, id: recorded, text: "<any>" }),
        replyData("session.prompt", {
          id: recorded,
          sessionID: session,
          time: { created: 1790656601410 },
          type: "user",
          payload: { text: "hi" },
          delivery: "steer",
        }),
        event("session.execution.started", { sessionID: session }),
      ];
      const { runtime, thread } = yield* resumed([
        out("session.get", { sessionID: OTHER }),
        replyData("session.get", sessionInfo({ id: OTHER })),
        out("permission.list", { sessionID: OTHER }),
        replyData("permission.list", []),
        out("session.form.list", { sessionID: OTHER }),
        replyData("session.form.list", []),
        ...promptInto(SESSION, "msg_recorded_turn_a"),
        ...steerInto(SESSION, "msg_recorded_steer_a"),
        out("session.instructions.entry.put", { sessionID: OTHER, key: "t3-code", value: "<any>" }),
        reply("session.instructions.entry.put", null),
        ...promptInto(OTHER, "msg_recorded_turn_b"),
        ...steerInto(OTHER, "msg_recorded_steer_b"),
      ]);
      const other = {
        ...thread,
        id: ProviderThreadId.make("provider-thread:opencode2-adapter:other"),
        nativeThreadRef: {
          driver: OPENCODE_PROVIDER,
          nativeId: OTHER,
          strength: "strong" as const,
        },
      };
      yield* runtime.resumeThread({
        providerThread: other,
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const ids = yield* IdAllocator.IdAllocatorV2;
      const ended = yield* terminals(runtime, 2);
      for (const [session, providerThread] of [
        [SESSION, thread],
        [OTHER, other],
      ] as const) {
        yield* runtime.startTurn(turnInput(providerThread));
        yield* runtime.steerTurn({
          threadId,
          runId: RunId.make("run:opencode2-adapter"),
          providerThread,
          providerTurnId: ids.derive.providerTurn({
            driver: OPENCODE_PROVIDER,
            nativeTurnId: `${session}:attempt:attempt:opencode2-adapter`,
          }),
          message: {
            ...turnInput(providerThread).message,
            messageId: MessageId.make("message:opencode2-adapter:steer"),
            text: "Also say STEERED.",
          },
        });
      }
      const statuses = [...(yield* Fiber.join(ended))].map((terminal) => terminal.status);
      assert.deepEqual(statuses, ["completed", "completed"]);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
  );

  // regression: #16775 unchanged session status updates were rewritten on every event
  it.effect("reports the shared session's status only when it changes", () =>
    Effect.gen(function* () {
      const OTHER = "ses_f148ca2deffeOtherSession000";
      const promptInto = (
        session: string,
        recorded: string,
      ): ReadonlyArray<ProviderReplayEntry> => [
        out("session.prompt", { sessionID: session, id: recorded, text: "<any>" }),
        replyData("session.prompt", {
          id: recorded,
          sessionID: session,
          time: { created: 1790656601410 },
          type: "user",
          payload: { text: "hi" },
          delivery: "steer",
        }),
      ];
      const { runtime, thread } = yield* resumed([
        out("session.get", { sessionID: OTHER }),
        replyData("session.get", sessionInfo({ id: OTHER })),
        out("permission.list", { sessionID: OTHER }),
        replyData("permission.list", []),
        out("session.form.list", { sessionID: OTHER }),
        replyData("session.form.list", []),
        ...promptInto(SESSION, "msg_recorded_turn_a"),
        out("session.instructions.entry.put", { sessionID: OTHER, key: "t3-code", value: "<any>" }),
        reply("session.instructions.entry.put", null),
        ...promptInto(OTHER, "msg_recorded_turn_b"),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: OTHER }),
      ]);
      const other = {
        ...thread,
        id: ProviderThreadId.make("provider-thread:opencode2-adapter:other"),
        nativeThreadRef: {
          driver: OPENCODE_PROVIDER,
          nativeId: OTHER,
          strength: "strong" as const,
        },
      };
      yield* runtime.resumeThread({
        providerThread: other,
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      let ended = 0;
      const collected = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal" && ++ended === 2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      yield* runtime.startTurn(turnInput(other));
      assert.deepEqual(
        [...(yield* Fiber.join(collected))].flatMap((event) =>
          event.type === "provider_session.updated" ? [event.providerSession.status] : [],
        ),
        ["running", "ready"],
      );
    }).pipe(Effect.scoped),
  );
  it.effect.each([
    ["refuses a rollback while a timed-out Stop's run is still going", true],
  ] as const)("%s", ([, running]) =>
    Effect.gen(function* () {
      const prompt = `msg_t3_turn_${SESSION}:attempt:opencode2-adapter`;
      const { runtime, thread } = yield* resumed([
        ...stopTimedOut,
        out("session.active"),
        reply("session.active", { data: running ? { [SESSION]: { type: "running" } } : {} }),
        ...(running
          ? []
          : [
              out("message.list", "<any>"),
              reply("message.list", {
                data: [{ id: prompt, time: { created: 1 }, text: "hi", type: "user" }],
                cursor: {},
              }),
              out("session.revert.stage", {
                sessionID: SESSION,
                messageID: prompt,
                files: false,
              }),
              replyData("session.revert.stage", { messageID: prompt, files: [] }),
              out("session.revert.commit", { sessionID: SESSION }),
              reply("session.revert.commit", null),
              out("message.list", "<any>"),
              reply("message.list", { data: [], cursor: {} }),
            ]),
      ]);
      yield* stopFirstTurn(runtime, thread);
      const now = yield* DateTime.now;
      const first = {
        id: yield* providerTurnId,
        providerThreadId: thread.id,
        nodeId: NodeId.make("node:opencode2-adapter"),
        runAttemptId: RunAttemptId.make("attempt:opencode2-adapter"),
        nativeTurnRef: {
          driver: OPENCODE_PROVIDER,
          nativeId: prompt,
          strength: "weak" as const,
        },
        ordinal: 1,
        status: "interrupted" as const,
        startedAt: now,
        completedAt: now,
      };
      const rollback = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint:start"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [first],
        })
        .pipe(Effect.exit);
      if (running) {
        assert.isTrue(Exit.isFailure(rollback));
        const error = Exit.isFailure(rollback) ? Cause.squash(rollback.cause) : undefined;
        assert.equal(
          (error as { _tag?: string } | undefined)?._tag,
          "ProviderAdapterProtocolError",
        );
      } else {
        assert.isTrue(Exit.isSuccess(rollback));
      }
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  it.effect("takes back a stranded steer again when its first cancel failed", () =>
    Effect.gen(function* () {
      const steerId = `msg_t3_steer_${SESSION}:message:opencode2-adapter:steer`;
      const cancelOut = out("session.inbox.cancel", { sessionID: SESSION, inboxID: steerId });
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        out("session.prompt", {
          sessionID: SESSION,
          id: steerId,
          text: "<any>",
          delivery: "steer",
        }),
        replyData("session.prompt", {
          id: steerId,
          sessionID: SESSION,
          time: { created: 1790656601500 },
          type: "user",
          payload: { text: "Also say STEERED." },
          delivery: "steer",
        }),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
        event("session.execution.interrupted", { sessionID: SESSION }),
        cancelOut,
        reply("session.inbox.cancel", {
          status: 500,
          body: { _tag: "UnknownError", message: "busy" },
        }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        cancelOut,
        reply("session.inbox.cancel", null),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const seen: Array<string> = [];
      const ended = yield* Deferred.make<void>();
      const nextEnded = yield* Deferred.make<void>();
      // One consumer reads every terminal; a second reader would race it for the queue.
      const thirdEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type !== "turn.terminal") return;
            seen.push(event.status);
            if (seen.length === 1) yield* Deferred.succeed(ended, undefined);
            if (seen.length === 2) yield* Deferred.succeed(nextEnded, undefined);
            if (seen.length === 3) yield* Deferred.succeed(thirdEnded, undefined);
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      yield* runtime.steerTurn({
        threadId,
        runId: RunId.make("run:opencode2-adapter"),
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
        message: {
          ...turnInput(thread).message,
          messageId: MessageId.make("message:opencode2-adapter:steer"),
          text: "Also say STEERED.",
        },
      });
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
      });
      yield* Deferred.await(ended);
      yield* runtime.startTurn(secondTurn(thread));
      yield* Deferred.await(nextEnded);
      yield* runtime.startTurn({
        ...secondTurn(thread),
        runId: RunId.make("run:opencode2-adapter:3"),
        runOrdinal: 3,
        providerTurnOrdinal: 3,
        attemptId: RunAttemptId.make("attempt:opencode2-adapter:3"),
      });
      yield* Deferred.await(thirdEnded);
    }).pipe(Effect.scoped),
  );
  it.effect("drops the turns a rollback cut from the snapshot it returns", () =>
    Effect.gen(function* () {
      const kept = `msg_t3_turn_${SESSION}:attempt:opencode2-adapter`;
      const dropped = `msg_t3_turn_${SESSION}:attempt:opencode2-adapter:2`;
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("message.list", "<any>"),
        reply("message.list", {
          data: [
            { id: dropped, time: { created: 2 }, text: "second", type: "user" },
            { id: kept, time: { created: 1 }, text: "first", type: "user" },
          ],
          cursor: {},
        }),
        out("session.revert.stage", { sessionID: SESSION, messageID: dropped, files: false }),
        replyData("session.revert.stage", { messageID: dropped, files: [] }),
        out("session.revert.commit", { sessionID: SESSION }),
        reply("session.revert.commit", null),
        out("message.list", "<any>"),
        reply("message.list", {
          data: [{ id: kept, time: { created: 1 }, text: "first", type: "user" }],
          cursor: {},
        }),
      ]);
      const turns: Array<OrchestrationV2ProviderTurn> = [];
      const firstEnded = yield* Deferred.make<void>();
      const bothEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type === "provider_turn.updated" && event.providerTurn.status !== "running") {
              turns.push(event.providerTurn);
              if (turns.length === 1) yield* Deferred.succeed(firstEnded, undefined);
              if (turns.length === 2) yield* Deferred.succeed(bothEnded, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      yield* Deferred.await(firstEnded);
      yield* runtime.startTurn(secondTurn(thread));
      yield* Deferred.await(bothEnded);
      const [first, second] = turns;
      const snapshot = yield* runtime.rollbackThread({
        providerThread: thread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint:first"),
          appRunOrdinal: 1,
          providerTurn: first!,
        },
        providerThreadTurns: [first!, second!],
      });
      assert.deepEqual(
        snapshot.providerTurns.map((turn) => turn.id),
        [first!.id],
      );
    }).pipe(Effect.scoped),
  );
  it.effect("starts a turn sent during a rollback only once the cut is made", () =>
    Effect.gen(function* () {
      const prompted = `msg_t3_turn_${SESSION}:attempt:earlier`;
      const { runtime, thread } = yield* resumed([
        out("message.list", "<any>"),
        reply("message.list", {
          data: [{ id: prompted, time: { created: 1 }, text: "earlier", type: "user" }],
          cursor: {},
        }),
        out("session.revert.stage", { sessionID: SESSION, messageID: prompted, files: false }),
        replyData("session.revert.stage", { messageID: prompted, files: [] }),
        out("session.revert.commit", { sessionID: SESSION }),
        reply("session.revert.commit", null),
        out("message.list", "<any>"),
        reply("message.list", { data: [], cursor: {} }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const now = yield* DateTime.now;
      const earlier = {
        id: ProviderTurnId.make("provider-turn:earlier"),
        providerThreadId: thread.id,
        nodeId: NodeId.make("node:earlier"),
        runAttemptId: RunAttemptId.make("attempt:earlier"),
        nativeTurnRef: { driver: OPENCODE_PROVIDER, nativeId: prompted, strength: "weak" as const },
        ordinal: 1,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      };
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const rollback = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint:start"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [earlier],
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* runtime.startTurn({ ...turnInput(thread), providerTurnOrdinal: 1 });
      yield* Fiber.join(rollback);
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }).pipe(Effect.scoped),
  );
  it.effect.each([
    [
      "keeps the recorded turns before the target when rolling back a session not loaded yet",
      false,
    ],
  ] as const)("%s", ([, running]) =>
    Effect.gen(function* () {
      const first = `msg_t3_turn_${SESSION}:attempt:first`;
      const second = `msg_t3_turn_${SESSION}:attempt:second`;
      const runtime = yield* openCode2ReplayRuntime([
        ...opening,
        out("session.active"),
        reply("session.active", { data: running ? { [SESSION]: { type: "running" } } : {} }),
        ...(running
          ? []
          : [
              out("session.get", { sessionID: SESSION }),
              replyData("session.get", sessionInfo()),
              ...noOpenRequests,
              out("message.list", "<any>"),
              reply("message.list", {
                data: [
                  { id: second, time: { created: 2 }, text: "second", type: "user" },
                  { id: first, time: { created: 1 }, text: "first", type: "user" },
                ],
                cursor: {},
              }),
              out("session.revert.stage", {
                sessionID: SESSION,
                messageID: second,
                files: false,
              }),
              replyData("session.revert.stage", { messageID: second, files: [] }),
              out("session.revert.commit", { sessionID: SESSION }),
              reply("session.revert.commit", null),
              out("message.list", "<any>"),
              reply("message.list", {
                data: [{ id: first, time: { created: 1 }, text: "first", type: "user" }],
                cursor: {},
              }),
            ]),
      ]);
      const thread = providerThread(yield* DateTime.now);
      const now = yield* DateTime.now;
      const recorded = (key: string, ordinal: number, nativeId: string) => ({
        id: ProviderTurnId.make(`provider-turn:${key}`),
        providerThreadId: thread.id,
        nodeId: NodeId.make(`node:${key}`),
        runAttemptId: RunAttemptId.make(`attempt:${key}`),
        nativeTurnRef: { driver: OPENCODE_PROVIDER, nativeId, strength: "weak" as const },
        ordinal,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      });
      const kept = recorded("first", 1, first);
      const rollback = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:first"),
            appRunOrdinal: 1,
            providerTurn: kept,
          },
          providerThreadTurns: [kept, recorded("second", 2, second)],
        })
        .pipe(Effect.exit);
      if (running) {
        const error = Exit.isFailure(rollback) ? Cause.squash(rollback.cause) : undefined;
        assert.equal(
          (error as { _tag?: string } | undefined)?._tag,
          "ProviderAdapterProtocolError",
        );
      } else {
        assert.isTrue(Exit.isSuccess(rollback));
        assert.deepEqual(
          Exit.isSuccess(rollback) ? rollback.value.providerTurns.map((turn) => turn.id) : [],
          [kept.id],
        );
      }
    }).pipe(Effect.scoped),
  );
  it.effect("refuses to fork a session while OpenCode runs a follow-up on it", () =>
    Effect.gen(function* () {
      const offered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        event("session.execution.started", { sessionID: SESSION }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: () => Deferred.succeed(offered, undefined).pipe(Effect.asVoid),
          take: Effect.never,
        }),
      );
      yield* Deferred.await(offered);
      const refused = yield* runtime
        .forkThread({
          sourceProviderThread: thread,
          targetThreadId: ThreadId.make("thread:opencode2-adapter:fork"),
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "ProviderAdapterProtocolError");
    }).pipe(Effect.scoped),
  );
  it.effect("moves a fork into its target thread's worktree before the first prompt", () =>
    Effect.gen(function* () {
      const FORK = "ses_f1484db83ffeLGtrRCFimo1H0e";
      const target = "/work/opencode2-fork-target";
      const { runtime, thread } = yield* resumed([
        out("session.fork", { sessionID: SESSION }),
        replyData("session.fork", sessionInfo({ id: FORK })),
        out("session.update", {
          sessionID: FORK,
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
            { action: "t3-code-*", resource: "*", effect: "deny" },
            { action: "t3-code-thread_opencode2-adapter_fork_*", resource: "*", effect: "allow" },
          ],
        }),
        reply("session.update", null),
        // OpenCode makes the fork where its source runs; the target thread runs elsewhere.
        out("session.move", { sessionID: FORK, directory: target }),
        reply("session.move", null),
      ]);
      const forked = yield* runtime.forkThread({
        sourceProviderThread: thread,
        targetThreadId: ThreadId.make("thread:opencode2-adapter:fork"),
        runtimePolicy: { ...policy(), cwd: target },
      });
      assert.equal(forked.nativeThreadRef?.nativeId, FORK);
    }).pipe(Effect.scoped),
  );
  it.effect("forks before a continuation's report, so the fork leaves out its answer", () =>
    Effect.gen(function* () {
      const FORK = "ses_f1484db83ffeLGtrRCFimo1H0e";
      const { runtime, thread, first, second } = yield* continued([
        out("message.list", { sessionID: SESSION, limit: "100", type: "user" }),
        reply("message.list", { data: [continuedHistory.data[1]], cursor: {} }),
        out("message.list", { sessionID: SESSION, limit: "100", type: "synthetic" }),
        reply("message.list", {
          data: [
            { id: "msg_later_report", time: { created: 3 }, text: "later", type: "synthetic" },
          ],
          cursor: { next: "synthetic-page-2" },
        }),
        out("message.list", {
          sessionID: SESSION,
          limit: "100",
          type: "synthetic",
          cursor: "synthetic-page-2",
        }),
        reply("message.list", { data: [continuedHistory.data[0]], cursor: {} }),
        out("session.fork", { sessionID: SESSION, before: "msg_report" }),
        replyData("session.fork", sessionInfo({ id: FORK })),
        out("session.update", { sessionID: FORK, permissions: "<any>" }),
        reply("session.update", null),
      ]);
      const forked = yield* runtime.forkThread({
        sourceProviderThread: thread,
        targetThreadId: ThreadId.make("thread:opencode2-adapter:fork"),
        providerTurnId: first.id,
        sourceProviderTurns: [first, second],
      });
      assert.equal(forked.nativeThreadRef?.nativeId, FORK);
    }).pipe(Effect.scoped),
  );
});
