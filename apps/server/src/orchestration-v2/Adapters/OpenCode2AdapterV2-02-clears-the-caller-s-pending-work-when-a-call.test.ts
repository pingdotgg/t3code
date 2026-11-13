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
  WORK,
  threadId,
  out,
  reply,
  replyData,
  event,
  t3Rules,
  sessionInfo,
  promptAccepted,
  noOpenRequests,
  openCode2ReplayRuntimeWithInstructions,
  opening,
  directoryModels,
  bigPickle,
  policy,
  providerThread,
  turnInput,
  agentList,
  supervisedRules,
  shellAsk,
  shellAskEvent,
  colorForm,
  resumed,
  requestOf,
  terminalOf,
  backgroundLaunch,
  withLineage,
  continuationTurn,
  CHILD,
  MIDDLE,
  DEEP,
  toolOf,
  deepReport,
  nestedLaunch,
  watchNested,
  stopTimedOut,
  secondTurn,
  stopFirstTurn,
  terminals,
  replyAfterUnclearFailure,
  providerTurnId,
} from "./OpenCode2AdapterV2-fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 adapter", (it) => {
  it.effect("clears the caller's pending work when a called session's held wake runs", () =>
    Effect.gen(function* () {
      const OTHER = "ses_other00000000000000000000";
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const gate = makeProviderReplayGate(["drained"]);
      const { runtime, thread } = yield* resumed(
        [
          out("session.get", { sessionID: OTHER }),
          replyData("session.get", sessionInfo({ id: OTHER })),
          out("permission.list", { sessionID: OTHER }),
          replyData("permission.list", []),
          out("session.form.list", { sessionID: OTHER }),
          replyData("session.form.list", []),
          event("session.execution.started", { sessionID: OTHER }),
          event("session.execution.succeeded", { sessionID: OTHER }),
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          event("session.tool.input.started", {
            ...toolOf(SESSION, "call-other"),
            name: "subagent",
          }),
          event("session.tool.called", {
            ...toolOf(SESSION, "call-other"),
            name: "subagent",
            input: { description: "Other", prompt: "again" },
            executed: false,
          }),
          event("session.tool.progress", {
            ...toolOf(SESSION, "call-other"),
            metadata: { sessionID: OTHER, status: "running" },
          }),
          event("session.tool.success", {
            ...toolOf(SESSION, "call-other"),
            content: [{ type: "text", text: "OTHER_OK" }],
            metadata: { sessionID: OTHER, status: "completed", truncated: false },
            executed: false,
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event(
            "session.model.selected",
            {
              sessionID: OTHER,
              model: { providerID: "opencode", id: "big-pickle", variant: "none" },
            },
            "drained",
          ),
        ],
        { replayGate: gate },
      ).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) =>
            Effect.sync(() => {
              offers.push(request);
            }),
          take: Effect.never,
        }),
      );
      const other = yield* runtime.resumeThread({
        providerThread: {
          ...thread,
          id: ProviderThreadId.make("provider-thread:opencode2-adapter:other"),
          nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: OTHER, strength: "strong" },
        },
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const watch = yield* watchNested(runtime);
      yield* watch.until(() => offers.length === 1);
      yield* runtime.startTurn(withLineage(thread));
      assert.isTrue(yield* Effect.promise(() => gate.waitForReached("drained")));
      // The called session's held wake is its caller's pending work too.
      yield* watch.until(() => watch.pendingSnapshots.get(SESSION) === true);
      yield* runtime.startTurn(continuationTurn(other, offers[0]!));
      gate.release("drained");
      yield* watch.until(() => watch.variants.get(OTHER) === "none");
      assert.isFalse(watch.pendingSnapshots.get(OTHER));
      assert.isFalse(watch.pendingSnapshots.get(SESSION));
    }).pipe(Effect.scoped),
  );
  it.effect("stops a foreground subagent's background subagent after the turn ended", () =>
    Effect.gen(function* () {
      const offered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        ...nestedLaunch,
        out("session.interrupt", { sessionID: DEEP }),
        reply("session.interrupt", { interrupted: true }),
        event("session.execution.interrupted", { sessionID: DEEP }),
        deepReport("cancelled"),
        event("session.execution.started", { sessionID: MIDDLE }),
        out("session.interrupt", { sessionID: MIDDLE }),
        reply("session.interrupt", { interrupted: true }),
        event("session.execution.interrupted", { sessionID: MIDDLE }),
        event("session.execution.started", { sessionID: SESSION }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: () => Deferred.succeed(offered, undefined).pipe(Effect.asVoid),
          take: Effect.never,
        }),
      );
      const watch = yield* watchNested(runtime);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.until(() => watch.terminals.length > 0);
      assert.deepEqual(watch.terminals, ["completed"]);
      assert.equal(watch.deep.at(-1), "running");
      assert.isTrue(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
        requestRuntimeRestart: true,
      });
      yield* Deferred.await(offered);
      assert.equal(watch.deep.at(-1), "interrupted");
      assert.deepEqual([...watch.middleTurns.keys()], [`${MIDDLE}:turn:1`]);
    }).pipe(Effect.scoped),
  );
  it.effect("stops the turn a foreground subagent runs to answer its background subagent", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...nestedLaunch,
        event("session.execution.succeeded", { sessionID: DEEP }),
        deepReport("completed"),
        event("session.execution.started", { sessionID: MIDDLE }),
        event("session.text.ended", {
          sessionID: MIDDLE,
          assistantMessageID: "msg_assistant_answer",
          ordinal: 0,
          text: "Noted.",
        }),
        out("session.interrupt", { sessionID: MIDDLE }),
        reply("session.interrupt", { interrupted: true }),
        event("session.execution.interrupted", { sessionID: MIDDLE }),
      ]);
      const watch = yield* watchNested(runtime);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.until(() => watch.middleTurns.get(`${MIDDLE}:turn:2`) === "running");
      assert.equal(watch.deep.at(-1), "completed");
      assert.isTrue(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
        requestRuntimeRestart: true,
      });
      yield* watch.until(() => watch.middleTurns.get(`${MIDDLE}:turn:2`) === "interrupted");
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
    }).pipe(Effect.scoped),
  );
  it.effect("never lets a timed-out Stop's late end finish the next turn", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...stopTimedOut,
        out("session.active"),
        reply("session.active", { data: {} }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.failed", {
          sessionID: SESSION,
          error: { type: "provider", message: "second turn failed" },
        }),
      ]);
      const ended = yield* terminals(runtime, 2);
      yield* stopFirstTurn(runtime, thread);
      yield* runtime.startTurn(secondTurn(thread));
      const [first, second] = yield* Fiber.join(ended);
      assert.equal(first?.status, "interrupted");
      assert.equal(second?.status, "failed");
      assert.equal(second?.failure?.message, "second turn failed");
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  it.effect("checks the server before prompting again after a prompt request failed", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        reply("session.prompt", {
          status: 502,
          body: { _tag: "UnknownError", message: "bad gateway" },
        }),
        out("session.active"),
        reply("session.active", { data: { [SESSION]: { type: "running" } } }),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
      ]);
      const ended = yield* terminals(runtime, 2);
      yield* runtime.startTurn(turnInput(thread)).pipe(Effect.ignore);
      yield* runtime.startTurn(secondTurn(thread));
      const [first, second] = yield* Fiber.join(ended);
      assert.equal(first?.status, "failed");
      assert.equal(second?.failure?.message, OPENCODE_2_STILL_STOPPING);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  // regression: #14744 continuations hung after a reconnect took a Stop's end
  it.effect("still checks the server when a failed prompt's execution starts late", () =>
    Effect.gen(function* () {
      const offered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        reply("session.prompt", {
          status: 502,
          body: { _tag: "UnknownError", message: "bad gateway" },
        }),
        event("session.execution.started", { sessionID: SESSION }),
        out("session.active"),
        reply("session.active", { data: { [SESSION]: { type: "running" } } }),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: () => Deferred.succeed(offered, undefined).pipe(Effect.asVoid),
          take: Effect.never,
        }),
      );
      const ended = yield* terminals(runtime, 2);
      yield* runtime.startTurn(turnInput(thread)).pipe(Effect.ignore);
      yield* Deferred.await(offered);
      yield* runtime.startTurn(secondTurn(thread));
      const [first, second] = yield* Fiber.join(ended);
      assert.equal(first?.status, "failed");
      assert.equal(second?.failure?.message, OPENCODE_2_STILL_STOPPING);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  it.effect("ends a background reply's continuation after a lost stream took a Stop's end", () =>
    Effect.gen(function* () {
      const offered =
        yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
      const gate = makeProviderReplayGate(["drop", "reply"]);
      const { runtime, thread } = yield* resumed(
        [
          ...backgroundLaunch(CHILD),
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", "<hang>"),
          out("session.active"),
          replyData("session.active", { [SESSION]: { type: "running" } }),
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", { interrupted: true }),
          event("session.usage.updated", { sessionID: SESSION }, "drop"),
          { type: "runtime_exit", status: "success" } as const,
          out("event.subscribe"),
          out("session.active"),
          replyData("session.active", { [CHILD]: { type: "running" } }),
          out("permission.list", { sessionID: CHILD }),
          replyData("permission.list", []),
          out("session.form.list", { sessionID: CHILD }),
          replyData("session.form.list", []),
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
          event(
            "session.text.ended",
            {
              sessionID: SESSION,
              assistantMessageID: "msg_followup",
              ordinal: 0,
              text: "CHILD_OK",
            },
            "reply",
          ),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.execution.started", { sessionID: CHILD }),
        ],
        { replayGate: gate },
      ).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Deferred.succeed(offered, request).pipe(Effect.asVoid),
          take: Effect.never,
        }),
      );
      const attached = yield* Deferred.make<void>();
      const collected = yield* runtime.events.pipe(
        Stream.tap((event) =>
          event.type === "subagent.updated" && event.subagent.childThreadId !== null
            ? Deferred.succeed(attached, undefined)
            : Effect.void,
        ),
        Stream.takeUntil(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId?.startsWith(`${CHILD}:turn:`) === true,
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(attached);
      const interrupt = yield* runtime
        .interruptTurn({ providerThread: thread, providerTurnId: yield* providerTurnId })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("11 seconds");
      yield* Fiber.join(interrupt);
      yield* runtime.startTurn({ ...secondTurn(thread), appThread: withLineage(thread).appThread });
      gate.release("drop");
      yield* runtime.startTurn({
        ...continuationTurn(thread, yield* Deferred.await(offered)),
        runOrdinal: 3,
        providerTurnOrdinal: 3,
      });
      gate.release("reply");
      const events = [...(yield* Fiber.join(collected))];
      assert.deepEqual(
        events.flatMap((event) => (event.type === "turn.terminal" ? [event.status] : [])),
        ["interrupted", "failed", "completed"],
      );
      assert.include(
        events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? [event.turnItem.text]
            : [],
        ),
        "CHILD_OK",
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  it.effect("ends a background reply's continuation after a prompt failed unclearly", () =>
    replyAfterUnclearFailure(false),
  );
  it.effect("reports a turn as completed when its Stop request failed", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", {
          status: 500,
          body: { _tag: "UnknownError", message: "interrupt failed" },
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      const failed = yield* runtime
        .interruptTurn({ providerThread: thread, providerTurnId: yield* providerTurnId })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "ProviderAdapterInterruptError");
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }).pipe(Effect.scoped),
  );
  it.effect("gives a resumed session T3's rules when it was made with others", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        ...opening,
        out("session.get", { sessionID: SESSION }),
        replyData(
          "session.get",
          sessionInfo({
            permissions: [
              { action: "*", resource: "*", effect: "allow" },
              { action: "subagent", resource: "*", effect: "deny" },
            ],
          }),
        ),
        ...noOpenRequests,
        out("session.update", { sessionID: SESSION, permissions: t3Rules }),
        reply("session.update", null),
      ]);
      yield* runtime.resumeThread({
        providerThread: providerThread(yield* DateTime.now),
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
    }).pipe(Effect.scoped),
  );
  it.effect("moves the session when the thread's worktree changed", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        ...opening,
        ...directoryModels("/work/opencode2-feature"),
        out("session.get", { sessionID: SESSION }),
        replyData("session.get", sessionInfo()),
        ...noOpenRequests,
        out("session.move", { sessionID: SESSION, directory: "/work/opencode2-feature" }),
        reply("session.move", null),
      ]);
      yield* runtime.resumeThread({
        providerThread: providerThread(yield* DateTime.now),
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: { ...policy(), cwd: "/work/opencode2-feature" },
      });
    }).pipe(Effect.scoped),
  );
  it.effect("breaks the thread and forgets it when the session was deleted outside T3", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        reply("session.prompt", {
          status: 404,
          body: {
            _tag: "SessionNotFoundError",
            sessionID: SESSION,
            message: `Session not found: ${SESSION}`,
          },
        }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread)).pipe(Effect.ignore);
      const ended = yield* Fiber.join(terminal);
      assert.equal(ended?.status, "failed");
      assert.equal(ended?.threadDisposition, "broken");
      const again = yield* runtime.startTurn(turnInput(thread)).pipe(Effect.flip);
      assert.equal(again._tag, "ProviderAdapterProtocolError");
      assert.include(again.message, "not registered");
    }).pipe(Effect.scoped),
  );
  it.effect("stops the requests a session still waits on when a restarted T3 loads it", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntimeWithInstructions(
        [
          ...opening,
          out("session.get", { sessionID: SESSION }),
          replyData("session.get", sessionInfo()),
          out("permission.list", { sessionID: SESSION }),
          replyData("permission.list", [shellAsk.data]),
          out("session.form.list", { sessionID: SESSION }),
          replyData("session.form.list", [colorForm]),
          out("permission.reply", {
            sessionID: SESSION,
            requestID: shellAsk.data.id,
            decision: "reject",
          }),
          reply("permission.reply", null),
          out("session.form.cancel", { sessionID: SESSION, formID: colorForm.id }),
          reply("session.form.cancel", null),
          out("session.active"),
          reply("session.active", { data: {} }),
          event("session.execution.interrupted", { sessionID: SESSION, reason: "user" }),
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { external: true },
      );
      const thread = yield* runtime.resumeThread({
        providerThread: providerThread(yield* DateTime.now),
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }).pipe(Effect.scoped),
  );
  it.effect("ends the turn when an answer to its request cannot be delivered", () =>
    Effect.gen(function* () {
      const failedReply = reply("permission.reply", {
        status: 500,
        body: { _tag: "UnknownError", message: "reply failed" },
      });
      const replyOut = out("permission.reply", {
        sessionID: SESSION,
        requestID: shellAsk.data.id,
        decision: "once",
      });
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          shellAskEvent,
          replyOut,
          failedReply,
          replyOut,
          failedReply,
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", { interrupted: true }),
        ],
        { supervised: true },
      );
      const requested = yield* requestOf(runtime).pipe(Effect.forkScoped);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const request = yield* Fiber.join(requested);
      yield* runtime.respondToRuntimeRequest({ requestId: request!.id, decision: "accept" });
      const ended = yield* Fiber.join(terminal);
      assert.equal(ended?.status, "failed");
      assert.equal(
        ended?.status === "failed" ? ended.failure.message : undefined,
        "OpenCode is waiting on a request T3 Code couldn't answer.",
      );
    }).pipe(Effect.scoped),
  );
  it.effect("counts an answer to a request OpenCode already dropped as delivered", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          shellAskEvent,
          out("permission.reply", {
            sessionID: SESSION,
            requestID: shellAsk.data.id,
            decision: "once",
          }),
          reply("permission.reply", {
            status: 404,
            body: {
              _tag: "PermissionNotFoundError",
              requestID: shellAsk.data.id,
              message: "Permission request not found",
            },
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { supervised: true },
      );
      const requested = yield* requestOf(runtime).pipe(Effect.forkScoped);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const request = yield* Fiber.join(requested);
      yield* runtime.respondToRuntimeRequest({ requestId: request!.id, decision: "accept" });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }).pipe(Effect.scoped),
  );
  it.effect("declines a form T3 cannot show with the reason, instead of leaving it open", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("form.created", {
          form: {
            id: "frm_0eb79ab35001fkvFECSh3wYNVD",
            sessionID: SESSION,
            title: "MCP authorization",
            metadata: { kind: "mcp" },
            fields: [
              {
                key: "authorization",
                type: "external",
                url: "https://example.com/authorize",
                title: "Authorize",
              },
            ],
          },
        }),
        out("session.form.cancel", {
          sessionID: SESSION,
          formID: "frm_0eb79ab35001fkvFECSh3wYNVD",
        }),
        reply("session.form.cancel", null),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      const ended = yield* Fiber.join(terminal);
      assert.equal(ended?.status, "failed");
      assert.include(
        ended?.status === "failed" ? ended.failure.message : "",
        "asked for a link to open",
      );
    }).pipe(Effect.scoped),
  );
  it.effect("asks a subagent's permission request on the parent thread's turn", () =>
    Effect.gen(function* () {
      const child = "ses_f0e5aa64cffelFnoQRL0DAA9BH";
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.created", {
            sessionID: child,
            slug: "stellar-garden",
            version: "2.0.18",
            projectID: "global",
            parentID: SESSION,
            location: { directory: WORK },
            subpath: "",
            title: "Echo test command",
            agent: "general",
            permissions: supervisedRules,
            model: { id: "big-pickle", providerID: "opencode", variant: "default" },
          }),
          event("permission.asked", { ...shellAsk.data, sessionID: child }),
          out("permission.reply", {
            sessionID: child,
            requestID: shellAsk.data.id,
            decision: "once",
          }),
          reply("permission.reply", null),
          event("permission.replied", {
            sessionID: child,
            requestID: shellAsk.data.id,
            reply: "once",
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { supervised: true },
      );
      const requested = yield* requestOf(runtime).pipe(Effect.forkScoped);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const request = yield* Fiber.join(requested);
      assert.equal(request?.nativeRequestRef?.nativeId, shellAsk.data.id);
      yield* runtime.respondToRuntimeRequest({ requestId: request!.id, decision: "accept" });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }).pipe(Effect.scoped),
  );
  it.effect("keeps 'allow this session' in the session's rules, not OpenCode's saved grants", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          shellAskEvent,
          out("session.update", {
            sessionID: SESSION,
            permissions: [
              ...supervisedRules.slice(0, 3),
              { action: "shell", resource: "echo *", effect: "allow" },
              ...supervisedRules.slice(3),
            ],
          }),
          reply("session.update", null),
          out("permission.reply", {
            sessionID: SESSION,
            requestID: shellAsk.data.id,
            decision: "once",
          }),
          reply("permission.reply", null),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { supervised: true },
      );
      const requested = yield* requestOf(runtime).pipe(Effect.forkScoped);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const request = yield* Fiber.join(requested);
      yield* runtime.respondToRuntimeRequest({
        requestId: request!.id,
        decision: "acceptForSession",
      });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }).pipe(Effect.scoped),
  );
  it.effect("reads the agents again while a fresh server still lists none", () =>
    Effect.gen(function* () {
      // OpenCode 2.0.18 briefly returns no agents on startup; using that response drops agent paths.
      const runtime = yield* openCode2ReplayRuntime([
        ...opening,
        out("agent.list", "<any>"),
        reply("agent.list", { location: { directory: WORK }, data: [] }),
        out("agent.list", "<any>"),
        reply("agent.list", agentList),
        out("session.create", {
          location: { directory: WORK },
          model: { providerID: "opencode", id: "big-pickle" },
          permissions: supervisedRules,
        }),
        replyData("session.create", sessionInfo({ permissions: supervisedRules })),
      ]);
      const created = yield* runtime
        .ensureThread({
          threadId,
          modelSelection: bigPickle,
          runtimePolicy: policy("approval-required"),
        })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("250 millis");
      assert.equal((yield* Fiber.join(created)).nativeThreadRef?.nativeId, SESSION);
    }).pipe(Effect.scoped),
  );
});
