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
  instanceId,
  out,
  reply,
  event,
  durable,
  mcpRules,
  promptAccepted,
  bigPickle,
  policy,
  providerThread,
  turnInput,
  agentList,
  supervisedRules,
  resumed,
  terminalOf,
  backgroundLaunch,
  withLineage,
  continuationTurn,
  CHILD,
  watchBackgroundTurn,
  callAgain,
  childReport,
  watchCalls,
  launchedAndRunning,
  MIDDLE,
  DEEP,
  toolOf,
  deepReport,
  nestedLaunch,
  watchNested,
  terminals,
  providerTurnId,
} from "./OpenCode2AdapterV2-fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 adapter", (it) => {
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
      assert.deepEqual(thread.nativeMetadata?.modelSelection, {
        ...bigPickle,
        options: [{ id: "variant", value: "default" }],
      });
      assert.equal(bigPickle.options, undefined);
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
  it.effect("renames the session before the first turn after the thread was renamed", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.update", { sessionID: SESSION, title: "Prime factors of 391" }),
        reply("session.update", null),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const renamed = {
        ...turnInput(thread),
        appThread: { title: "Prime factors of 391" } as OrchestrationV2AppThread,
      };
      const first = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(renamed);
      assert.equal((yield* Fiber.join(first))?.status, "completed");
      const second = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn({
        ...renamed,
        runId: RunId.make("run:opencode2-adapter:2"),
        attemptId: RunAttemptId.make("attempt:opencode2-adapter:2"),
      });
      assert.equal((yield* Fiber.join(second))?.status, "completed");
    }).pipe(Effect.scoped),
  );
  it.effect("ends a turn on the provider thread it started on", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const forkedRow = {
        ...thread,
        id: ProviderThreadId.make("provider-thread:opencode2-adapter:forked-run-row"),
      };
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(forkedRow));
      assert.equal((yield* Fiber.join(terminal))?.providerThreadId, forkedRow.id);
    }).pipe(Effect.scoped),
  );

  // regression: #18315 OpenCode Go quota stops were not shown as usage limits
  it.effect.each([
    ["provider.quota", "usage_limit"],
    ["provider.rate-limit", "usage_limit"],
    ["provider", "provider_error"],
  ] as const)("classifies a %s execution failure as %s", ([code, failureClass]) =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.failed", {
          sessionID: SESSION,
          error: { type: code, message: "Provider rejected the request" },
        }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      const ended = yield* Fiber.join(terminal);
      assert.equal(ended?.status, "failed");
      assert.deepEqual(ended?.failure, {
        class: failureClass,
        code,
        message: "Provider rejected the request",
        retryable: null,
      });
    }).pipe(Effect.scoped),
  );

  // OpenCode types an empty balance as provider.quota too, but answers it with
  // HTTP 402 and it never resets. Usage windows and budgets arrive as 429.
  it.effect.each([
    {
      name: "an out-of-funds provider.quota (402)",
      failureClass: "provider_error",
      error: {
        type: "provider.quota",
        message: "Upstream request failed: Insufficient account funds",
        status: 402,
      },
    },
    {
      name: "a provider.quota usage window (429)",
      failureClass: "usage_limit",
      error: {
        type: "provider.quota",
        message: "Subscription quota exceeded.",
        status: 429,
        response: {
          body: JSON.stringify({
            type: "error",
            error: { type: "GoUsageLimitError", message: "Subscription quota exceeded." },
          }),
        },
      },
    },
    {
      name: "a provider.quota account budget (429)",
      failureClass: "usage_limit",
      error: {
        type: "provider.quota",
        message: "Upstream request failed: Account budget exceeded",
        status: 429,
      },
    },
    {
      name: "a provider.rate-limit failure (429)",
      failureClass: "usage_limit",
      error: {
        type: "provider.rate-limit",
        message: "Rate limit exceeded: free-models-per-min.",
        status: 429,
      },
    },
    {
      name: "a Claude limit without a reset timestamp",
      failureClass: "usage_limit",
      error: {
        type: "provider.unknown",
        message: "You've hit your session limit · resets 5:20pm (Europe/Berlin)",
      },
    },
    {
      name: "an unrelated provider.unknown failure",
      failureClass: "provider_error",
      error: {
        type: "provider.unknown",
        message: "Request failed. Resets at 2026-11-02T20:00:00Z.",
      },
    },
  ] as const)("classifies $name as $failureClass", ({ error, failureClass }) =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.failed", { sessionID: SESSION, error }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      const ended = yield* Fiber.join(terminal);
      assert.equal(ended?.status, "failed");
      assert.deepEqual(ended?.failure, {
        class: failureClass,
        code: error.type,
        message: error.message,
        retryable: null,
      });
    }).pipe(Effect.scoped),
  );

  // regression: #29289 Claude weekly limits through claude-agent lost their usage-limit reset
  it.effect(
    "classifies a Claude weekly limit as a usage limit that resets at its reported time",
    () =>
      Effect.gen(function* () {
        const message =
          "You've hit your weekly limit · resets 9pm (Europe/Paris) Resets at 2026-11-02T20:00:00.000Z.";
        const { runtime, thread } = yield* resumed([
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.failed", {
            sessionID: SESSION,
            error: { type: "provider.unknown", message },
          }),
        ]);
        const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
        yield* runtime.startTurn(turnInput(thread));
        const ended = yield* Fiber.join(terminal);
        assert.equal(ended?.status, "failed");
        assert.deepEqual(ended?.failure, {
          class: "usage_limit",
          code: "provider.unknown",
          message,
          retryable: null,
          resetAt: "2026-11-02T20:00:00.000Z",
        });
      }).pipe(Effect.scoped),
  );
  it.effect("ends the turn when its terminal event is one this build cannot decode", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
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
  it.effect("sends nothing for a turn stopped while extracting document text", () =>
    Effect.gen(function* () {
      const resolving = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const prompts: Array<unknown> = [];
      const { runtime, thread } = yield* resumed(
        [
          out("session.instructions.entry.put", {
            sessionID: SESSION,
            key: "t3-code",
            value: "<any>",
          }),
          reply("session.instructions.entry.put", null),
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", { interrupted: false }),
        ],
        {
          attachmentsDir: "/attachments",
          onPrompt: (input) => prompts.push(input),
          resolveExtractedTextPath: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(resolving, undefined);
              yield* Deferred.await(release);
              return undefined;
            }),
        },
      );
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const started = yield* runtime
        .startTurn({
          ...turnInput(thread),
          message: {
            ...turnInput(thread).message,
            attachments: [
              ChatFileAttachment.make({
                type: "file",
                id: ChatAttachmentId.make(
                  "thread-opencode2-adapter-12345678-1234-1234-1234-123456789abc",
                ),
                name: "report.rtf",
                mimeType: "application/rtf",
                sizeBytes: 4,
              }),
            ],
          },
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(resolving);
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(started);
      assert.equal((yield* Fiber.join(terminal))?.status, "interrupted");
      assert.lengthOf(prompts, 0);
    }).pipe(Effect.scoped),
  );
  it.effect("keeps background subagents running when a turn is interrupted to restart it", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
        event("session.execution.interrupted", { sessionID: SESSION }),
      ]);
      const watch = yield* watchBackgroundTurn(runtime);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.attached;
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
      });
      assert.equal((yield* watch.terminal)?.status, "interrupted");
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
    }).pipe(Effect.scoped),
  );
  it.effect("stops background subagents on a user Stop", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        out("session.interrupt", { sessionID: CHILD }),
        reply("session.interrupt", { interrupted: true }),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
        event("session.execution.interrupted", { sessionID: SESSION }),
      ]);
      const watch = yield* watchBackgroundTurn(runtime);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.attached;
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
        requestRuntimeRestart: true,
      });
      assert.equal((yield* watch.terminal)?.status, "interrupted");
      assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
    }).pipe(Effect.scoped),
  );
  it.effect("gives a background subagent the rules of a mode changed while it runs", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("agent.list", "<any>"),
        reply("agent.list", agentList),
        out("session.update", { sessionID: SESSION, permissions: supervisedRules }),
        reply("session.update", null),
        out("session.update", {
          sessionID: CHILD,
          permissions: [...supervisedRules.slice(0, 3), ...mcpRules],
        }),
        reply("session.update", null),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const firstEnded = yield* Deferred.make<void>();
      const ended = yield* runtime.events.pipe(
        Stream.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        ),
        Stream.tap(() => Deferred.succeed(firstEnded, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(firstEnded);
      yield* runtime.startTurn({
        ...withLineage(thread),
        runId: RunId.make("run:opencode2-adapter:2"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("attempt:opencode2-adapter:2"),
        runtimePolicy: policy("approval-required"),
      });
      assert.deepEqual(
        [...(yield* Fiber.join(ended))].map((terminal) => terminal.status),
        ["completed", "completed"],
      );
    }).pipe(Effect.scoped),
  );
  it.effect(
    "keeps a finished background subagent's queued report pending until its native continuation ends",
    () =>
      Effect.gen(function* () {
        const gate = makeProviderReplayGate(["continue"]);
        const { runtime, thread } = yield* resumed(
          [
            ...nestedLaunch,
            event("session.execution.succeeded", { sessionID: DEEP }),
            deepReport("completed"),
            event("session.model.selected", {
              sessionID: SESSION,
              model: { providerID: "opencode", id: "big-pickle", variant: "thinking" },
            }),
            event("session.execution.started", { sessionID: MIDDLE }, "continue"),
            event("session.inbox.delivered", { sessionID: MIDDLE, inboxID: "msg_deep_report" }),
            event("session.text.ended", {
              sessionID: MIDDLE,
              assistantMessageID: "msg_native_continuation",
              ordinal: 0,
              text: "GRANDCHILD_OK",
            }),
            event("session.execution.succeeded", { sessionID: MIDDLE }),
            event("session.model.selected", {
              sessionID: SESSION,
              model: { providerID: "opencode", id: "big-pickle", variant: "none" },
            }),
          ],
          { replayGate: gate },
        );
        const queued = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        const timeline: Array<boolean | string> = [];
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "provider_thread.updated") {
                if (
                  event.providerThread.nativeThreadRef?.nativeId === MIDDLE &&
                  event.pendingBackgroundWork !== undefined
                ) {
                  timeline.push(event.pendingBackgroundWork);
                }
                if (event.providerThread.id === thread.id) {
                  const variant =
                    event.providerThread.nativeMetadata?.modelSelection?.options?.[0]?.value;
                  if (variant === "thinking") yield* Deferred.succeed(queued, undefined);
                  if (variant === "none") yield* Deferred.succeed(drained, undefined);
                }
              }
              if (
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === `${MIDDLE}:turn:2`
              ) {
                timeline.push(event.providerTurn.status);
              }
              if (event.type === "message.updated" && event.message.text === "GRANDCHILD_OK") {
                timeline.push(event.message.text);
              }
            }),
          ),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(withLineage(thread));
        yield* Deferred.await(queued);
        assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
        assert.isTrue(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
        assert.strictEqual(timeline.at(-1), true);
        timeline.length = 0;
        gate.release("continue");
        yield* Deferred.await(drained);
        assert.deepEqual(
          timeline.filter((entry) => typeof entry === "string"),
          ["running", "GRANDCHILD_OK", "completed"],
        );
        assert.isAbove(timeline.indexOf(false), timeline.indexOf("completed"));
        assert.strictEqual(timeline.at(-1), false);
        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
      }).pipe(Effect.scoped),
  );
  it.effect("settles a background subagent that fails, so no work is left pending", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...launchedAndRunning,
        // The parent turn ends, and the background child fails: it reports
        // nothing back, so its call has to end with the failure.
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.failed", {
          sessionID: CHILD,
          error: { type: "provider.quota", message: "Rate limit exceeded." },
        }),
      ]);
      const watch = yield* watchCalls(runtime, thread);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.until(
        () => watch.calls.get("Sleep")?.status === "failed" && watch.state.roster?.length === 0,
      );
      assert.deepEqual(watch.state.roster, []);
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
    }).pipe(Effect.scoped),
  );

  // regression: #21979 a failed background subagent pinned its thread as busy
  it.effect("settles the background call a foreground call joined to a failed child", () =>
    Effect.gen(function* () {
      const again = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-again" };
      const { runtime, thread } = yield* resumed([
        ...launchedAndRunning,
        // A foreground call joins the running background child. It is only
        // marked background once its own tool call returns, so the child can
        // fail while this call is still the foreground one.
        event("session.tool.input.started", { ...again, name: "subagent" }),
        event("session.tool.called", {
          ...again,
          name: "subagent",
          input: { description: "Again", prompt: "also this", sessionID: CHILD },
          executed: false,
        }),
        event("session.tool.progress", {
          ...again,
          metadata: { sessionID: CHILD, status: "running" },
        }),
        out("session.update", { sessionID: CHILD, permissions: "<any>" }),
        reply("session.update", null),
        // The child fails while the joined call is still the foreground one.
        event("session.execution.failed", {
          sessionID: CHILD,
          error: { type: "provider.quota", message: "Rate limit exceeded." },
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const watch = yield* watchCalls(runtime, thread);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.until(
        () =>
          watch.calls.get("Sleep")?.status === "failed" &&
          watch.calls.get("Again")?.status === "failed" &&
          watch.state.roster?.length === 0,
      );
      assert.deepEqual(watch.state.roster, []);
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
    }).pipe(Effect.scoped),
  );
  it.effect("settles every call that joined a running subagent with its one report", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...launchedAndRunning,
        ...callAgain({ background: true }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        childReport("msg_report", "CHILD_OK"),
      ]);
      const watch = yield* watchCalls(runtime, thread);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.until(
        () =>
          watch.calls.get("Again")?.status === "completed" &&
          watch.calls.get("Sleep")?.status === "completed" &&
          watch.state.roster?.length === 0,
      );
      assert.deepEqual(Object.fromEntries(watch.calls), {
        Sleep: { status: "completed", result: "CHILD_OK" },
        Again: { status: "completed", result: "CHILD_OK" },
      });
    }).pipe(Effect.scoped),
  );
  it.effect("keeps a call to a finished subagent for its own run's report", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...launchedAndRunning,
        event("session.execution.succeeded", { sessionID: CHILD }),
        ...callAgain({ background: true }),
        childReport("msg_report_1", "FIRST_OK"),
        event("session.execution.started", { sessionID: CHILD }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        childReport("msg_report_2", "SECOND_OK"),
      ]);
      const watch = yield* watchCalls(runtime, thread);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.until(() => watch.childTurns.has(`${CHILD}:turn:2`));
      assert.deepEqual(watch.callsAtChildTurnStart.get(`${CHILD}:turn:2`), {
        Sleep: { status: "completed", result: "FIRST_OK" },
        Again: { status: "running", result: null },
      });
      yield* watch.until(() => watch.calls.get("Again")?.status === "completed");
      assert.deepEqual(watch.calls.get("Again"), { status: "completed", result: "SECOND_OK" });
    }).pipe(Effect.scoped),
  );
  it.effect("clears a nested report cancelled during a held wake", () =>
    Effect.gen(function* () {
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const gate = makeProviderReplayGate(["drained"]);
      const { runtime, thread } = yield* resumed(
        [
          ...backgroundLaunch(CHILD),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.execution.succeeded", { sessionID: CHILD }),
          childReport("msg_report", "CHILD_OK"),
          event("session.execution.started", { sessionID: SESSION }),
          ...nestedLaunch.slice(3, -2),
          event(
            "session.tool.success",
            {
              ...toolOf(SESSION, "call-middle"),
              content: [{ type: "text", text: "MIDDLE_OK" }],
              metadata: { sessionID: MIDDLE, status: "completed", truncated: false },
              executed: false,
            },
            undefined,
            2,
          ),
          event("session.execution.succeeded", { sessionID: DEEP }),
          deepReport("completed"),
          event("session.inbox.cancelled", { sessionID: MIDDLE, inboxID: "msg_deep_report" }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.model.selected", {
            sessionID: SESSION,
            model: { providerID: "opencode", id: "big-pickle", variant: "thinking" },
          }),
          event(
            "session.model.selected",
            {
              sessionID: SESSION,
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
      const watch = yield* watchNested(runtime);
      yield* runtime.startTurn(withLineage(thread));
      assert.isTrue(yield* Effect.promise(() => gate.waitForReached("drained")));
      yield* watch.until(() => watch.rootVariant === "thinking");
      assert.lengthOf(offers, 1);
      yield* runtime.startTurn(continuationTurn(thread, offers[0]!));
      gate.release("drained");
      yield* watch.until(() => watch.rootVariant === "none");
      assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
      assert.strictEqual(watch.pendingSnapshots.get(MIDDLE), false);
    }).pipe(Effect.scoped),
  );
});
