/**
 * Failures and settings a live OpenCode 2 server cannot produce on demand,
 * driven through the real adapter and `@opencode/client` against a replayed
 * HTTP server. Frames reuse the shapes recorded against 2.0.18.
 */
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import { TestClock } from "effect/testing";
import { describe } from "vite-plus/test";

import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { OPENCODE_PROVIDER } from "./OpenCodeAdapterV2.ts";
import { OPENCODE_2_FULL_ACCESS_ONLY, OPENCODE_2_STILL_STOPPING } from "./OpenCode2AdapterV2.ts";
import { openCode2ReplayRuntime } from "./OpenCode2AdapterV2.testkit.ts";

const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";
const WORK = "/work/opencode2";
const instanceId = ProviderInstanceId.make("opencode");
const threadId = ThreadId.make("thread:opencode2-adapter");

const out = (type: string, input?: unknown): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: input === undefined ? { type } : { type, input },
});
/** A recorded response body; `{ data }` is the server's envelope, `null` an empty 204. */
const reply = (operation: string, data: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { type: "sdk.response", operation, data },
});
const replyData = (operation: string, data: unknown) => reply(operation, { data });
const event = (type: string, data: Record<string, unknown>): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: {
    type: "sdk.event",
    event: { id: `evt_${type.replaceAll(".", "")}0000`, created: 1, type, data, ...durable },
  },
});
const durable = { durable: { aggregateID: SESSION, seq: 1, version: 1 } };

/** The rules T3 gives every session it runs. */
const t3Rules = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "subagent", resource: "*", effect: "deny" },
];
const sessionInfo = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION,
  permissions: t3Rules,
  projectID: "global",
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1790656601394, updated: 1790656601394 },
  location: { directory: WORK },
  ...overrides,
});
const promptAccepted = replyData("session.prompt", {
  id: "msg_0eb735d41001NJee1EvVePJAK5",
  sessionID: SESSION,
  time: { created: 1790656601410 },
  type: "user",
  payload: { text: "hi" },
  delivery: "steer",
});

const bigPickle: ModelSelection = { instanceId, model: "opencode/big-pickle" };
const policy = (runtimeMode: "full-access" | "approval-required" = "full-access") => ({
  runtimeMode,
  interactionMode: "default" as const,
  cwd: WORK,
});

const providerThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make("provider-thread:opencode2-adapter"),
  driver: OPENCODE_PROVIDER,
  providerInstanceId: instanceId,
  providerSessionId: ProviderSessionId.make("provider-session:opencode2-adapter"),
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: SESSION, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});

const turnInput = (
  thread: OrchestrationV2ProviderThread,
  modelSelection: ModelSelection = bigPickle,
  runtimeMode: "full-access" | "approval-required" = "full-access",
) => ({
  appThread: {} as OrchestrationV2AppThread,
  threadId,
  runId: RunId.make("run:opencode2-adapter"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make("attempt:opencode2-adapter"),
  rootNodeId: NodeId.make("node:opencode2-adapter"),
  providerThread: thread,
  message: {
    messageId: MessageId.make("message:opencode2-adapter"),
    text: "hi",
    attachments: [],
    createdBy: "user" as const,
    creationSource: "web" as const,
    scheduledTaskId: undefined,
    senderThreadId: undefined,
  },
  modelSelection,
  runtimePolicy: policy(runtimeMode),
});

/** Resumes the recorded session and returns the runtime, the thread, and its event stream. */
const resumed = (entries: ReadonlyArray<ProviderReplayEntry>, options?: { external?: boolean }) =>
  Effect.gen(function* () {
    const runtime = yield* openCode2ReplayRuntime(
      [
        out("event.subscribe"),
        out("session.get", { sessionID: SESSION }),
        replyData("session.get", sessionInfo()),
        ...entries,
      ],
      options,
    );
    const thread = yield* runtime.resumeThread({
      providerThread: providerThread(yield* DateTime.now),
      threadId,
      modelSelection: bigPickle,
      runtimePolicy: policy(),
    });
    return { runtime, thread };
  });

const terminalOf = (runtime: ProviderAdapterV2SessionRuntime) =>
  runtime.events.pipe(
    Stream.filter(
      (event): event is Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> =>
        event.type === "turn.terminal",
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

describe("OpenCode2 adapter", () => {
  it.effect("switches the session's model and variant before a turn that changed them", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.switchModel", {
          sessionID: SESSION,
          model: { providerID: "openrouter", id: "deepseek/deepseek-v4-flash", variant: "high" },
        }),
        reply("session.switchModel", null),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(
        turnInput(thread, {
          instanceId,
          model: "openrouter/deepseek/deepseek-v4-flash",
          options: [{ id: "variant", value: "high" }],
        }),
      );
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses a turn outside Full access instead of running it with every tool allowed",
    () =>
      Effect.gen(function* () {
        // No prompt is expected: the turn fails without reaching the server.
        const { runtime, thread } = yield* resumed([]);
        const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
        yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
        const refused = yield* Fiber.join(terminal);
        assert.deepInclude(refused?.failure, {
          class: "validation_error",
          message: OPENCODE_2_FULL_ACCESS_ONLY,
        });
      }).pipe(Effect.scoped),
  );

  it.effect("ends the turn when its terminal event is one this build cannot decode", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        // A reason added after 2.0.18: the full schema rejects the frame.
        event("session.execution.interrupted", { sessionID: SESSION, reason: "budget" }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      assert.equal((yield* Fiber.join(terminal))?.status, "interrupted");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a turn running through a start event this build cannot decode", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        {
          type: "emit_inbound",
          frame: {
            type: "sdk.event",
            event: {
              id: "evt_executionstartedx",
              created: 1,
              type: "session.execution.started",
              data: { sessionID: SESSION },
              durable: "not-an-envelope",
            },
          },
        },
        event("session.text.started", {
          sessionID: SESSION,
          assistantMessageID: "msg_0eb735d5b001oAFVeY5jz3WD4Z",
          ordinal: 0,
        }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_0eb735d5b001oAFVeY5jz3WD4Z",
          ordinal: 0,
          text: "DONE",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const collected = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const seen = yield* Fiber.join(collected);
      const terminals = seen.filter((event) => event.type === "turn.terminal");
      assert.deepEqual(
        terminals.map((event) => event.type === "turn.terminal" && event.status),
        ["completed"],
      );
      // The reply after the malformed start still reached the turn.
      assert.isTrue(
        seen.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text === "DONE",
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("denies the subagent tool on the sessions it creates", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntime([
        out("event.subscribe"),
        out("session.create", {
          location: { directory: WORK },
          model: { providerID: "opencode", id: "big-pickle" },
          permissions: t3Rules,
        }),
        replyData("session.create", sessionInfo()),
      ]);
      const thread = yield* runtime.ensureThread({
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      assert.equal(thread.nativeThreadRef?.nativeId, SESSION);
    }).pipe(Effect.scoped),
  );

  it.effect("stops running turns on an external server when the session closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", { interrupted: true }),
        ],
        { external: true },
      ).pipe(Scope.provide(scope));
      yield* runtime.startTurn(turnInput(thread));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("ends a turn locally when a stuck server never answers Stop", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", "<hang>"),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      const interrupt = yield* runtime
        .interruptTurn({
          providerThread: thread,
          providerTurnId: yield* providerTurnId,
        })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("11 seconds");
      yield* Fiber.join(interrupt);
      assert.equal((yield* Fiber.join(terminal))?.status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  /** A prompt accepted, then a Stop the server never answers, advanced past its timeout. */
  const stopTimedOut: ReadonlyArray<ProviderReplayEntry> = [
    out("session.prompt", { sessionID: SESSION, text: "<any>" }),
    promptAccepted,
    out("session.interrupt", { sessionID: SESSION }),
    reply("session.interrupt", "<hang>"),
  ];
  const secondTurn = (thread: OrchestrationV2ProviderThread) => ({
    ...turnInput(thread),
    runId: RunId.make("run:opencode2-adapter:2"),
    runOrdinal: 2,
    providerTurnOrdinal: 2,
    attemptId: RunAttemptId.make("attempt:opencode2-adapter:2"),
  });
  const stopFirstTurn = (
    runtime: ProviderAdapterV2SessionRuntime,
    thread: OrchestrationV2ProviderThread,
  ) =>
    Effect.gen(function* () {
      yield* runtime.startTurn(turnInput(thread));
      const interrupt = yield* runtime
        .interruptTurn({ providerThread: thread, providerTurnId: yield* providerTurnId })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("11 seconds");
      yield* Fiber.join(interrupt);
    });
  const terminals = (runtime: ProviderAdapterV2SessionRuntime, count: number) =>
    runtime.events.pipe(
      Stream.filter(
        (event): event is Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      ),
      Stream.take(count),
      Stream.runCollect,
      Effect.forkScoped,
    );

  it.effect("never lets a timed-out Stop's late end finish the next turn", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...stopTimedOut,
        // The server no longer runs the stopped execution, so the next turn goes ahead.
        out("session.active"),
        reply("session.active", { data: {} }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        // The stopped execution's end arrives late, then the new turn's own.
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
      // Only the second turn's own end finishes it.
      assert.equal(second?.status, "failed");
      assert.equal(second?.failure?.message, "second turn failed");
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect(
    "starts the next turn once the server no longer runs a timed-out Stop's execution",
    () =>
      Effect.gen(function* () {
        const { runtime, thread } = yield* resumed([
          ...stopTimedOut,
          out("session.active"),
          reply("session.active", { data: {} }),
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ]);
        const ended = yield* terminals(runtime, 2);
        yield* stopFirstTurn(runtime, thread);
        yield* runtime.startTurn(secondTurn(thread));
        const [, second] = yield* Fiber.join(ended);
        assert.equal(second?.status, "completed");
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("reads a timed-out Stop's next turn from an execution start it cannot decode", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...stopTimedOut,
        out("session.active"),
        reply("session.active", { data: {} }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        // A newer server's start: the full schema rejects it, but it still opens the turn.
        {
          type: "emit_inbound",
          frame: {
            type: "sdk.event",
            event: {
              id: "evt_executionstartednewer",
              created: 1,
              type: "session.execution.started",
              data: { sessionID: SESSION },
              durable: "not-an-envelope",
            },
          },
        },
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_0eb735d5b001oAFVeY5jz3WD4Z",
          ordinal: 0,
          text: "DONE",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const ended = yield* terminals(runtime, 2);
      yield* stopFirstTurn(runtime, thread);
      yield* runtime.startTurn(secondTurn(thread));
      const [, second] = yield* Fiber.join(ended);
      assert.equal(second?.status, "completed");
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("checks the server before prompting again after a prompt request failed", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        // The request failed, but the server may have taken the prompt.
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

  it.effect("prompts again without a check after the server refused a prompt", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        reply("session.prompt", {
          status: 400,
          body: { _tag: "InvalidRequestError", message: "bad prompt" },
        }),
        // A clear refusal: nothing runs, so the next turn prompts directly.
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const ended = yield* terminals(runtime, 2);
      yield* runtime.startTurn(turnInput(thread)).pipe(Effect.ignore);
      yield* runtime.startTurn(secondTurn(thread));
      const [first, second] = yield* Fiber.join(ended);
      assert.deepEqual([first?.status, second?.status], ["failed", "completed"]);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("stops a timed-out Stop's execution again and fails the turn while it runs", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...stopTimedOut,
        out("session.active"),
        reply("session.active", { data: { [SESSION]: { type: "running" } } }),
        // Stopped again, and the turn fails without a prompt.
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
      ]);
      const ended = yield* terminals(runtime, 2);
      yield* stopFirstTurn(runtime, thread);
      yield* runtime.startTurn(secondTurn(thread));
      const [, second] = yield* Fiber.join(ended);
      assert.equal(second?.status, "failed");
      assert.equal(second?.failure?.message, OPENCODE_2_STILL_STOPPING);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("does not report a Stop the server says did nothing", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: false }),
      ]);
      yield* runtime.startTurn(turnInput(thread));
      const failed = yield* runtime
        .interruptTurn({
          providerThread: thread,
          providerTurnId: yield* providerTurnId,
        })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "ProviderAdapterProtocolError");
    }).pipe(Effect.scoped),
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

  it.effect("refuses to resume a thread without an OpenCode session as a protocol error", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntime([out("event.subscribe")]);
      const failed = yield* runtime
        .resumeThread({
          providerThread: { ...providerThread(yield* DateTime.now), nativeThreadRef: null },
        })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "ProviderAdapterProtocolError");
    }).pipe(Effect.scoped),
  );

  it.effect("gives a resumed session T3's rules when it was made with others", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntime([
        out("event.subscribe"),
        out("session.get", { sessionID: SESSION }),
        // Made before the subagent rule: it still allows everything.
        replyData(
          "session.get",
          sessionInfo({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }),
        ),
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
      const runtime = yield* openCode2ReplayRuntime([
        out("event.subscribe"),
        out("session.get", { sessionID: SESSION }),
        replyData("session.get", sessionInfo()),
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

  it.effect(
    "moves the session when a thread it resumes through ensureThread changed worktree",
    () =>
      Effect.gen(function* () {
        const runtime = yield* openCode2ReplayRuntime([
          out("event.subscribe"),
          out("session.get", { sessionID: SESSION }),
          replyData("session.get", sessionInfo()),
          out("session.move", { sessionID: SESSION, directory: "/work/opencode2-feature" }),
          reply("session.move", null),
        ]);
        yield* runtime.ensureThread({
          threadId,
          modelSelection: bigPickle,
          runtimePolicy: { ...policy(), cwd: "/work/opencode2-feature" },
          existingProviderThread: providerThread(yield* DateTime.now),
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
      // The next turn must resume (and fail into a handoff), not reuse the dead session.
      const again = yield* runtime.startTurn(turnInput(thread)).pipe(Effect.flip);
      assert.equal(again._tag, "ProviderAdapterProtocolError");
      assert.include(again.message, "not registered");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a model slug that is not provider/model before creating a session", () =>
    Effect.gen(function* () {
      // Nothing but the session's opening is expected: no create, no prompt.
      const runtime = yield* openCode2ReplayRuntime([out("event.subscribe")]);
      const created = yield* runtime
        .ensureThread({
          threadId,
          modelSelection: { instanceId, model: "big-pickle" },
          runtimePolicy: policy(),
        })
        .pipe(Effect.flip);
      assert.equal(created._tag, "ProviderAdapterProtocolError");
      assert.include(created.message, "OpenCode model 'big-pickle' must use provider/model format");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a turn whose model slug is not provider/model before prompting", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread, { instanceId, model: "big-pickle" }));
      const refused = yield* Fiber.join(terminal);
      assert.equal(refused?.failure?.class, "validation_error");
      assert.include(refused?.failure?.message, "must use provider/model format");
    }).pipe(Effect.scoped),
  );

  it.effect("ends the turn when a permission it refuses cannot be answered", () =>
    Effect.gen(function* () {
      const failedReply = reply("permission.reply", {
        status: 500,
        body: { _tag: "UnknownError", message: "reply failed" },
      });
      const replyOut = out("permission.reply", {
        sessionID: SESSION,
        requestID: "per_0eb7c4d7e001Pyt8o50Vi4KrOO",
        decision: "reject",
        message: "<any>",
      });
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        {
          type: "emit_inbound",
          frame: {
            type: "sdk.event",
            event: {
              id: "evt_permissionasked0",
              created: 1,
              type: "permission.asked",
              data: {
                id: "per_0eb7c4d7e001Pyt8o50Vi4KrOO",
                sessionID: SESSION,
                action: "shell",
                resources: ["echo FIRST"],
              },
            },
          },
        },
        // One try and one retry, then the turn ends and the session is stopped.
        replyOut,
        failedReply,
        replyOut,
        failedReply,
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      const ended = yield* Fiber.join(terminal);
      assert.equal(ended?.status, "failed");
      assert.equal(
        ended?.status === "failed" ? ended.failure.message : undefined,
        "OpenCode is waiting on a request T3 Code couldn't answer.",
      );
      // Let the best-effort interrupt reach the server before the scope closes.
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    }).pipe(Effect.scoped),
  );

  it.effect("answers a question form instead of cancelling it", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        {
          type: "emit_inbound",
          frame: {
            type: "sdk.event",
            event: {
              id: "evt_formcreated0000",
              created: 1,
              type: "form.created",
              data: {
                form: {
                  id: "frm_0eb79ab35001fkvFECSh3wYNVD",
                  sessionID: SESSION,
                  title: "Questions",
                  metadata: { kind: "question" },
                  fields: [
                    {
                      key: "q0",
                      title: "Color preference",
                      type: "string",
                      options: [{ value: "Red", label: "Red" }],
                      custom: true,
                    },
                  ],
                },
              },
            },
          },
        },
        out("session.form.reply", {
          sessionID: SESSION,
          formID: "frm_0eb79ab35001fkvFECSh3wYNVD",
          answer: { q0: "Questions aren't supported by this OpenCode integration yet." },
        }),
        reply("session.form.reply", null),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a turn after the event stream is gone instead of prompting", () =>
    Effect.gen(function* () {
      // The stream ends with no turn running; no prompt is expected after it.
      const { runtime, thread } = yield* resumed([{ type: "runtime_exit", status: "success" }]);
      // The runtime ends its own events once the lost stream is settled.
      yield* runtime.events.pipe(Stream.runDrain);
      const refused = yield* runtime
        .startTurn(turnInput(thread))
        .pipe(Effect.flip, Effect.timeout("5 seconds"));
      assert.equal(refused._tag, "ProviderAdapterEventStreamError");
    }).pipe(Effect.scoped),
  );

  it.effect("reports the session as failed after a lost stream settles its turns", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        { type: "runtime_exit", status: "success" },
      ]);
      // The runtime's event stream has one consumer.
      const events = yield* runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const last = collected.findLast((event) => event.type === "provider_session.updated");
      assert.equal(
        last?.type === "provider_session.updated" ? last.providerSession.status : undefined,
        "error",
      );
    }).pipe(Effect.scoped),
  );
});

/** The provider turn the adapter derives for `turnInput`'s attempt. */
const providerTurnId = Effect.gen(function* () {
  const ids = yield* IdAllocator.IdAllocatorV2;
  return ids.derive.providerTurn({
    driver: OPENCODE_PROVIDER,
    nativeTurnId: `${SESSION}:attempt:attempt:opencode2-adapter`,
  });
}).pipe(Effect.provide(IdAllocator.layer));
