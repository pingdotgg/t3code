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
  promptAccepted,
  providerThread,
  turnInput,
  shellAsk,
  resumed,
  childCreated,
  backgroundLaunch,
  withLineage,
  continuationTurn,
  CHILD,
  secondTurn,
  terminals,
  providerTurnId,
} from "./OpenCode2AdapterV2-fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 adapter", (it) => {
  it.effect("keeps a subagent a stopped background reply started off the next turn", () =>
    Effect.gen(function* () {
      const CHILD_B = "ses_f1485c529ffeBBBBBBBBBBBBBB";
      const SPAWNED = "ses_f1485c529ffeDDDDDDDDDDDDDD";
      const NESTED = "ses_f1485c529ffeNNNNNNNNNNNNNN";
      const toolB = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-b" };
      const spawn = { sessionID: SESSION, assistantMessageID: "msg_reply", id: "call-spawn" };
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const gate = makeProviderReplayGate(["settled"]);
      const { runtime, thread } = yield* resumed(
        [
          ...backgroundLaunch(CHILD),
          event("session.tool.input.started", { ...toolB, name: "subagent" }),
          event("session.tool.called", {
            ...toolB,
            name: "subagent",
            input: { description: "Sleep", prompt: "sleep", background: true },
            executed: false,
          }),
          event("session.created", { ...childCreated(CHILD_B), sessionID: CHILD_B }),
          event("session.tool.progress", {
            ...toolB,
            metadata: { sessionID: CHILD_B, status: "running" },
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.execution.started", { sessionID: CHILD_B }),
          event("session.execution.succeeded", { sessionID: CHILD }),
          event("session.inbox.enqueued", {
            inboxID: "msg_report",
            sessionID: SESSION,
            item: {
              type: "synthetic",
              payload: {
                text: `<subagent sessionID="${CHILD}" state="completed" description="Sleep">\nCHILD_OK\n</subagent>`,
                description: "Sleep",
                metadata: {
                  source: "subagent",
                  childID: CHILD,
                  agent: "General",
                  state: "completed",
                },
              },
              delivery: "steer",
            },
          }),
          event("session.execution.started", { sessionID: SESSION }),
          event("session.tool.input.started", { ...spawn, name: "subagent" }),
          event("session.tool.called", {
            ...spawn,
            name: "subagent",
            input: { description: "Sleep", prompt: "sleep", background: true },
            executed: false,
          }),
          event("session.created", { ...childCreated(SPAWNED), sessionID: SPAWNED }),
          event("session.tool.progress", {
            ...spawn,
            metadata: { sessionID: SPAWNED, status: "running" },
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.text.ended", {
            sessionID: CHILD_B,
            assistantMessageID: "msg_child_b",
            ordinal: 0,
            text: "B_WORKING",
          }),
          out("session.interrupt", { sessionID: CHILD_B }),
          reply("session.interrupt", { interrupted: true }),
          event("session.execution.interrupted", { sessionID: CHILD_B }),
          out("session.interrupt", { sessionID: SPAWNED }),
          reply("session.interrupt", {
            status: 500,
            body: { _tag: "UnknownError", message: "interrupt failed" },
          }),
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          event("permission.asked", { ...shellAsk.data, id: "per_spawned", sessionID: SPAWNED }),
          out("permission.reply", {
            sessionID: SPAWNED,
            requestID: "per_spawned",
            decision: "reject",
          }),
          reply("permission.reply", null),
          event("session.created", {
            ...childCreated(NESTED),
            sessionID: NESTED,
            parentID: SPAWNED,
          }),
          event("permission.asked", { ...shellAsk.data, id: "per_nested", sessionID: NESTED }),
          out("permission.reply", {
            sessionID: NESTED,
            requestID: "per_nested",
            decision: "reject",
          }),
          reply("permission.reply", null),
          event("session.text.ended", {
            sessionID: SESSION,
            assistantMessageID: "msg_unrelated",
            ordinal: 0,
            text: "UNRELATED",
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          out("session.interrupt", { sessionID: SPAWNED }),
          reply("session.interrupt", { interrupted: true }),
          out("session.interrupt", { sessionID: NESTED }),
          reply("session.interrupt", { interrupted: true }),
          event("session.execution.interrupted", { sessionID: SPAWNED }),
          event("session.inbox.enqueued", {
            inboxID: "msg_report_spawned",
            sessionID: SESSION,
            item: {
              type: "synthetic",
              payload: {
                text: `<subagent sessionID="${SPAWNED}" state="cancelled" description="Sleep">\n</subagent>`,
                description: "Sleep",
                metadata: {
                  source: "subagent",
                  childID: SPAWNED,
                  agent: "General",
                  state: "cancelled",
                },
              },
              delivery: "steer",
            },
          }),
          event("session.execution.started", { sessionID: SESSION }),
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", { interrupted: true }),
          event("session.execution.interrupted", { sessionID: SESSION }, "settled"),
        ],
        { replayGate: gate },
      ).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Effect.sync(() => void offers.push(request)),
          take: Effect.never,
        }),
      );
      const collected: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const replyEnded = yield* Deferred.make<void>();
      const bothEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            collected.push(event);
            if (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message") {
              if (event.turnItem.text === "B_WORKING")
                yield* Deferred.succeed(replyEnded, undefined);
            }
            if (collected.filter((entry) => entry.type === "turn.terminal").length === 2) {
              yield* Deferred.succeed(bothEnded, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(replyEnded);
      assert.lengthOf(offers, 1);
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
        requestRuntimeRestart: true,
      });
      yield* runtime.startTurn({ ...secondTurn(thread), appThread: withLineage(thread).appThread });
      yield* Deferred.await(bothEnded);
      for (let stops = 0; stops < 2; stops++) {
        yield* runtime.interruptTurn({
          providerThread: thread,
          providerTurnId: yield* providerTurnId,
          requestRuntimeRestart: true,
        });
      }
      yield* Effect.promise(() => gate.waitForReached("settled"));
      gate.release("settled");
      assert.lengthOf(offers, 1);
      assert.deepEqual(
        collected.flatMap((event) =>
          event.type === "runtime_request.updated"
            ? [`${event.runtimeRequest.nativeRequestRef?.nativeId}:${event.runtimeRequest.status}`]
            : [],
        ),
        [],
      );
    }).pipe(Effect.scoped),
  );

  // regression: #14752 continuations replayed background replies that were not theirs
  it.effect("ends a continuation while a skipped reply's subagent does not answer its Stop", () =>
    Effect.gen(function* () {
      const CHILD_B = "ses_f1485c529ffeBBBBBBBBBBBBBB";
      const SPAWNED = "ses_f1485c529ffeDDDDDDDDDDDDDD";
      const toolB = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-b" };
      const spawn = { sessionID: SESSION, assistantMessageID: "msg_reply_a", id: "call-spawn" };
      const report = (inboxID: string, child: string) =>
        event("session.inbox.enqueued", {
          inboxID,
          sessionID: SESSION,
          item: {
            type: "synthetic",
            payload: {
              text: `<subagent sessionID="${child}" state="completed" description="Sleep">\nOK\n</subagent>`,
              description: "Sleep",
              metadata: {
                source: "subagent",
                childID: child,
                agent: "General",
                state: "completed",
              },
            },
            delivery: "steer",
          },
        });
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const bothOffered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        event("session.tool.input.started", { ...toolB, name: "subagent" }),
        event("session.tool.called", {
          ...toolB,
          name: "subagent",
          input: { description: "Sleep", prompt: "sleep", background: true },
          executed: false,
        }),
        event("session.created", { ...childCreated(CHILD_B), sessionID: CHILD_B }),
        event("session.tool.progress", {
          ...toolB,
          metadata: { sessionID: CHILD_B, status: "running" },
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        report("msg_report_a", CHILD),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.tool.input.started", { ...spawn, name: "subagent" }),
        event("session.tool.called", {
          ...spawn,
          name: "subagent",
          input: { description: "Sleep", prompt: "sleep", background: true },
          executed: false,
        }),
        event("session.created", { ...childCreated(SPAWNED), sessionID: SPAWNED }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD_B }),
        report("msg_report_b", CHILD_B),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_reply_b",
          ordinal: 0,
          text: "REPLY_B",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("session.interrupt", { sessionID: SPAWNED }),
        reply("session.interrupt", "<hang>"),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) =>
            Effect.suspend(() =>
              offers.push(request) === 2
                ? Deferred.succeed(bothOffered, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          take: Effect.never,
        }),
      );
      const ended = yield* terminals(runtime, 2);
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(bothOffered);
      yield* runtime.startTurn(continuationTurn(thread, offers[1]!, "wake-b"));
      assert.deepEqual(
        [...(yield* Fiber.join(ended))].map((terminal) => terminal.status),
        ["completed", "completed"],
      );
    }).pipe(Effect.scoped),
  );
  it.effect("replays only its own background reply into a continuation turn", () =>
    Effect.gen(function* () {
      const CHILD_B = "ses_f1485c529ffeBBBBBBBBBBBBBB";
      const toolB = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-b" };
      const report = (inboxID: string, child: string, text: string) =>
        event("session.inbox.enqueued", {
          inboxID,
          sessionID: SESSION,
          item: {
            type: "synthetic",
            payload: {
              text: `<subagent sessionID="${child}" state="completed" description="Sleep">\n${text}\n</subagent>`,
              description: "Sleep",
              metadata: {
                source: "subagent",
                childID: child,
                agent: "General",
                state: "completed",
              },
            },
            delivery: "steer",
          },
        });
      const reply = (assistantMessageID: string, text: string) =>
        event("session.text.ended", { sessionID: SESSION, assistantMessageID, ordinal: 0, text });
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const bothOffered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        event("session.tool.input.started", { ...toolB, name: "subagent" }),
        event("session.tool.called", {
          ...toolB,
          name: "subagent",
          input: { description: "Sleep", prompt: "sleep", background: true },
          executed: false,
        }),
        event("session.created", { ...childCreated(CHILD_B), sessionID: CHILD_B }),
        event("session.tool.progress", {
          ...toolB,
          metadata: { sessionID: CHILD_B, status: "running" },
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        report("msg_report_a", CHILD, "A_OK"),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report_a" }),
        reply("msg_reply_a", "REPLY_A"),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD_B }),
        report("msg_report_b", CHILD_B, "B_OK"),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report_b" }),
        reply("msg_reply_b", "REPLY_B"),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) =>
            Effect.suspend(() =>
              offers.push(request) === 2
                ? Deferred.succeed(bothOffered, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          take: Effect.never,
        }),
      );
      const collected: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const ended = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            collected.push(event);
            if (collected.filter((entry) => entry.type === "turn.terminal").length === 2) {
              yield* Deferred.succeed(ended, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(bothOffered);
      yield* runtime.startTurn(continuationTurn(thread, offers[1]!, "wake-b"));
      yield* Deferred.await(ended);
      const continuationId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: OPENCODE_PROVIDER,
        nativeTurnId: `${SESSION}:attempt:attempt:opencode2-adapter:wake-b`,
      });
      assert.deepEqual(
        collected.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.providerTurnId === continuationId
            ? [event.turnItem.text]
            : [],
        ),
        ["REPLY_B"],
      );
      assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
  );
  it.effect("ends a follow-up turn a steer joined exactly once", () =>
    Effect.gen(function* () {
      const reportText = `<subagent sessionID="${CHILD}" state="completed" description="Sleep">\nCHILD_OK\n</subagent>`;
      const steerId = `msg_t3_steer_${SESSION}:message:opencode2-adapter:steer`;
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const offered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        event("session.inbox.enqueued", {
          inboxID: "msg_report",
          sessionID: SESSION,
          item: {
            type: "synthetic",
            payload: {
              text: reportText,
              description: "Sleep",
              metadata: {
                source: "subagent",
                childID: CHILD,
                agent: "General",
                state: "completed",
              },
            },
            delivery: "steer",
          },
        }),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report" }),
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
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: steerId }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_followup",
          ordinal: 0,
          text: "CHILD_OK STEERED",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) =>
            Effect.sync(() => void offers.push(request)).pipe(
              Effect.andThen(Deferred.succeed(offered, undefined)),
              Effect.asVoid,
            ),
          take: Effect.never,
        }),
      );
      const terminals: Array<string> = [];
      const followUpEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type !== "turn.terminal") return;
            terminals.push(event.status);
            if (terminals.length === 2) yield* Deferred.succeed(followUpEnded, undefined);
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(offered);
      const followUp = continuationTurn(thread, offers[0]!);
      yield* runtime.startTurn(followUp);
      const followUpTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: OPENCODE_PROVIDER,
        nativeTurnId: `${SESSION}:attempt:attempt:opencode2-adapter:wake`,
      });
      yield* runtime.steerTurn({
        threadId,
        runId: followUp.runId,
        providerThread: thread,
        providerTurnId: followUpTurnId,
        message: {
          ...turnInput(thread).message,
          messageId: MessageId.make("message:opencode2-adapter:steer"),
          text: "Also say STEERED.",
        },
      });
      yield* Deferred.await(followUpEnded);
      yield* Effect.yieldNow;
      assert.deepEqual(terminals, ["completed", "completed"]);
      assert.lengthOf(offers, 1);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
  );
});
