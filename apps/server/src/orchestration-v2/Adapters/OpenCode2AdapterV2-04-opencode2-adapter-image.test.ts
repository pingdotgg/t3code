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
  modelCatalog,
  PROMPT_ID,
  promptAccepted,
  noOpenRequests,
  openCode2ReplayRuntimeWithInstructions,
  opening,
  bigPickle,
  policy,
  providerThread,
  turnInput,
  shellAsk,
  resumed,
  terminalOf,
  history,
  secondTurn,
  terminals,
  reconnected,
  openRequests,
  turnItems,
  ASSISTANT,
  rateLimited,
  retryScheduled,
  retrying,
  firstRetry,
  errorRows,
  runRetryTurn,
  providerTurnId,
} from "./OpenCode2AdapterV2-fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 adapter", (it) => {
  it.effect.each([
    [false, "image", false],
    [true, "image", false],
    [false, "text", false],
    [true, "text", false],
    [true, "image", true],
    [true, "text", true],
  ] as const)(
    "rejects a steer stopped during attachment resolution (held end: %s, lookup: %s, cancel: %s)",
    ([heldEnd, lookup, cancel]) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-oc2-stopped-image-",
        });
        const image = ChatImageAttachment.make({
          type: "image",
          id: ChatAttachmentId.make(
            "thread-opencode2-adapter-12345678-1234-1234-1234-123456789abc",
          ),
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 4,
        });
        const path = resolveAttachmentPath({ attachmentsDir, attachment: image })!;
        yield* fileSystem.writeFileString(path, "data");
        const resolving = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const gate = makeProviderReplayGate(["execution-end", "interrupt-reply"]);
        const executionEnded = yield* Deferred.make<void>();
        const prompts: Array<unknown> = [];
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            event("session.execution.started", { sessionID: SESSION }),
            ...(heldEnd
              ? [
                  event("session.execution.succeeded", { sessionID: SESSION }, "execution-end"),
                  event("session.text.ended", {
                    sessionID: SESSION,
                    assistantMessageID: "msg_finished_before_stop",
                    ordinal: 0,
                    text: "Finished before Stop.",
                  }),
                ]
              : []),
            ...(cancel
              ? []
              : [
                  out("session.interrupt", { sessionID: SESSION }),
                  ...(heldEnd
                    ? [event("session.usage.updated", { sessionID: SESSION }, "interrupt-reply")]
                    : []),
                  reply("session.interrupt", { interrupted: !heldEnd }),
                  ...(heldEnd
                    ? []
                    : [event("session.execution.interrupted", { sessionID: SESSION })]),
                ]),
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            event("session.execution.started", { sessionID: SESSION }),
            event("session.execution.succeeded", { sessionID: SESSION }),
          ],
          {
            attachmentsDir,
            replayGate: gate,
            onPrompt: (input) => prompts.push(input),
            ...(lookup === "text"
              ? {
                  resolveExtractedTextPath: () =>
                    Effect.gen(function* () {
                      yield* Deferred.succeed(resolving, undefined);
                      yield* Deferred.await(release);
                      return undefined;
                    }),
                }
              : {}),
            fileSystem: {
              ...fileSystem,
              exists: (file) =>
                lookup === "image" && file === path
                  ? Effect.gen(function* () {
                      yield* Deferred.succeed(resolving, undefined);
                      yield* Deferred.await(release);
                      return yield* fileSystem.exists(file);
                    })
                  : fileSystem.exists(file),
            },
          },
        );
        const stopped = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const terminals: Array<string> = [];
        yield* runtime.events.pipe(
          Stream.tap((event) => {
            if (
              event.type === "turn_item.updated" &&
              event.turnItem.type === "assistant_message" &&
              event.turnItem.text === "Finished before Stop."
            ) {
              return Deferred.succeed(executionEnded, undefined);
            }
            if (event.type !== "turn.terminal") return Effect.void;
            terminals.push(event.status);
            return Deferred.succeed(terminals.length === 1 ? stopped : completed, undefined);
          }),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        const steer = yield* runtime
          .steerTurn({
            threadId,
            runId: RunId.make("run:opencode2-adapter"),
            providerThread: thread,
            providerTurnId: yield* providerTurnId,
            message: {
              ...turnInput(thread).message,
              messageId: MessageId.make("message:opencode2-adapter:steer"),
              text: "Do not send this image after Stop.",
              attachments: [image],
            },
          })
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(resolving);
        if (heldEnd) {
          gate.release("execution-end");
          yield* Deferred.await(executionEnded);
        }
        if (cancel) {
          yield* Fiber.interrupt(steer);
        }
        const interrupt = cancel
          ? undefined
          : yield* runtime
              .interruptTurn({
                providerThread: thread,
                providerTurnId: yield* providerTurnId,
              })
              .pipe(Effect.forkScoped);
        if (!cancel && heldEnd) {
          assert.isTrue(yield* Effect.promise(() => gate.waitForReached("interrupt-reply")));
        } else if (!cancel) {
          yield* Deferred.await(stopped);
        }
        yield* Deferred.succeed(release, undefined);
        assert.lengthOf(prompts, 1);
        if (cancel) {
          assert.isTrue(Exit.isFailure(yield* Fiber.await(steer)));
        } else {
          const result = yield* Fiber.join(steer);
          assert.isTrue(Exit.isFailure(result));
          if (Exit.isFailure(result)) {
            assert.deepInclude(Cause.squash(result.cause), {
              _tag: "ProviderAdapterProtocolError",
            });
          }
        }
        yield* Deferred.await(stopped);
        gate.release("interrupt-reply");
        if (interrupt) yield* Fiber.join(interrupt);
        yield* runtime.startTurn(secondTurn(thread));
        yield* Deferred.await(completed);
        assert.lengthOf(prompts, 2);
        assert.deepEqual(terminals, [cancel ? "completed" : "interrupted", "completed"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("reads user and assistant text from the session's message list", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        ...opening,
        out("message.list", { sessionID: SESSION, order: "asc", limit: "100" }),
        reply("message.list", history),
      ]);
      const snapshot = yield* runtime.readThreadSnapshot({
        providerThread: providerThread(yield* DateTime.now),
      });
      assert.deepEqual(
        snapshot.messages.map((message) => [message.role, message.text]),
        [
          ["user", history.data[0]!.text],
          ["assistant", "391 is not prime: it's the product 17 × 23."],
        ],
      );
      assert.equal(
        snapshot.providerThread.nativeConversationHeadRef?.nativeId,
        history.data[0]!.id,
      );
    }).pipe(Effect.scoped),
  );
  it.effect("ends a turn before re-reading a model list that never answers", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        out("event.subscribe"),
        out("model.list", "<any>"),
        reply("model.list", { location: { directory: WORK }, data: [] }),
        out("session.get", { sessionID: SESSION }),
        replyData("session.get", sessionInfo()),
        ...noOpenRequests,
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("model.list", "<any>"),
        reply("model.list", "<hang>"),
      ]);
      const thread = yield* runtime.resumeThread({
        providerThread: providerThread(yield* DateTime.now),
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    }).pipe(Effect.scoped),
  );
  it.effect("leaves models unknown when a step ends without a seen start", () =>
    Effect.gen(function* () {
      const tokens = { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
      const step = (id: string) => ({ sessionID: SESSION, assistantMessageID: id });
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.step.started", {
          ...step("msg_seen"),
          agent: "build",
          model: { id: "big-pickle", providerID: "opencode", variant: "default" },
          started: 1,
        }),
        event("session.step.ended", { ...step("msg_seen"), finish: "tool-calls", cost: 0, tokens }),
        event("session.step.ended", { ...step("msg_unseen"), finish: "stop", cost: 0, tokens }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const turn = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.completedAt !== null,
        ),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const settled = Option.getOrUndefined(yield* Fiber.join(turn));
      const usage =
        settled?.type === "provider_turn.updated" ? settled.providerTurn.turnTokenUsage : undefined;
      assert.deepInclude(usage, { usageStatus: "complete", inputTokens: 20, outputTokens: 2 });
      assert.notProperty(usage, "models");
    }).pipe(Effect.scoped),
  );
  it.effect("reports cache writes as cache creation, not only as input", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.step.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_0eb735d5b001oAFVeY5jz3WD4Z",
          finish: "stop",
          cost: 0,
          tokens: { input: 1200, output: 40, reasoning: 0, cache: { read: 300, write: 2500 } },
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const turn = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.completedAt !== null,
        ),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const settled = Option.getOrUndefined(yield* Fiber.join(turn));
      assert.deepInclude(
        settled?.type === "provider_turn.updated" ? settled.providerTurn.turnTokenUsage : undefined,
        {
          inputTokens: 1200 + 300 + 2500,
          cachedInputTokens: 300,
          cacheCreationTokens: 2500,
          outputTokens: 40,
        },
      );
    }).pipe(Effect.scoped),
  );
  it.effect.each([
    {
      name: "recovers a provider retry at the provider's first output",
      after: [
        event("session.text.started", {
          sessionID: SESSION,
          assistantMessageID: ASSISTANT,
          ordinal: 0,
        }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: ASSISTANT,
          ordinal: 0,
          text: "DONE",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ],
      items: ["error:running", "error:completed", "assistant_message:completed"],
      ended: "completed" as const,
      title: "Provider recovered",
    },
    {
      name: "stops a provider retry when the user stops the turn",
      after: [event("session.execution.interrupted", { sessionID: SESSION, reason: "user" })],
      items: ["error:running", "error:interrupted"],
      ended: "interrupted" as const,
      title: "Provider retry stopped",
    },
  ])("$name", ({ after, items, ended, title }) =>
    Effect.gen(function* () {
      const seen = yield* runRetryTurn([retryScheduled(2, 2_000), ...after]);
      assert.deepEqual(turnItems(seen), items);
      const rows = errorRows(seen);
      assert.deepEqual(
        rows.map(({ id, title, failure, retry }) => ({ id, title, failure, retry })),
        [
          { id: rows[0]!.id, title: "Provider retry", failure: retrying, retry: firstRetry },
          { id: rows[0]!.id, title, failure: retrying, retry: firstRetry },
        ],
      );
      assert.deepInclude(seen.at(-1), { type: "turn.terminal", status: ended, failure: null });
    }).pipe(Effect.scoped),
  );

  // regression: #15672 OpenCode 2 provider retries ran silently instead of showing
  it.effect.each([
    { name: "restores retry pending at reconnect", pending: true, streamed: false },
    { name: "settles retry recovered during drop", pending: false, streamed: false },
  ])("$name", ({ pending, streamed }) =>
    Effect.gen(function* () {
      const gate = makeProviderReplayGate(["finish"]);
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          ...(pending && !streamed ? [] : [retryScheduled(2, 2_000)]),
          ...reconnected({ [SESSION]: { type: "running" } }, undefined, {
            id: ASSISTANT,
            finish: undefined,
            content: pending ? [] : [{ type: "text", text: "Recovered during the drop." }],
            ...(pending && !streamed
              ? { retry: { attempt: 2, at: 2_001, error: rateLimited } }
              : {}),
            ...(streamed ? { time: { created: 2, streamed: 3 } } : {}),
          }),
          ...openRequests([shellAsk.data]),
          event("session.execution.succeeded", { sessionID: SESSION }, "finish"),
        ],
        { supervised: true, replayGate: gate },
      );
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      yield* Effect.promise(() => gate.waitForReached("finish"));
      gate.release("finish");
      const collected = yield* Fiber.join(events);
      // Reconciled requests follow backfill, before the terminal can settle the retry row.
      const reconciled = collected.findIndex((event) => event.type === "runtime_request.updated");
      assert.isAtLeast(reconciled, 0);
      const seen = collected.slice(0, reconciled);
      const rows = errorRows(seen);
      assert.deepEqual(
        rows.map(({ status, title }) => ({ status, title })),
        pending
          ? [{ status: "running", title: "Provider retry" }]
          : [
              { status: "running", title: "Provider retry" },
              { status: "completed", title: "Provider recovered" },
            ],
      );
      for (const row of rows) {
        assert.deepEqual(row.failure, retrying);
        assert.deepInclude(row.retry, { attempt: 1, maxAttempts: null });
        assert.equal(row.id, rows[0]!.id);
        assert.equal(row.ordinal, rows[0]!.ordinal);
        assert.deepEqual(row.startedAt, rows[0]!.startedAt);
      }
      if (!pending) {
        assert.isTrue(
          seen.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "assistant_message" &&
              event.turnItem.text === "Recovered during the drop.",
          ),
        );
      }
    }).pipe(Effect.scoped),
  );
  it.effect("replaces a provider retry with the error that failed the turn", () =>
    Effect.gen(function* () {
      const step = {
        sessionID: SESSION,
        assistantMessageID: ASSISTANT,
        agent: "build",
        model: { providerID: "opencode", id: "big-pickle", variant: "default" },
        started: 1,
      };
      const gate = makeProviderReplayGate(["second retry"]);
      // OpenCode starts the step of each attempt that fails, so a step start is no recovery.
      const seen = yield* runRetryTurn(
        [
          event("session.step.started", step),
          retryScheduled(2, 2_000),
          event("session.step.started", step, "second retry"),
          retryScheduled(3, 4_000),
          event("session.step.started", step),
          event("session.step.failed", {
            sessionID: SESSION,
            assistantMessageID: ASSISTANT,
            error: rateLimited,
          }),
          event("session.execution.failed", { sessionID: SESSION, error: rateLimited }),
        ],
        gate,
      );
      const failed = { ...retrying, class: "usage_limit" as const, retryable: null };
      const lastRetry = { attempt: 2, maxAttempts: null, retryDelayMs: 4_000 };
      const rows = errorRows(seen);
      assert.deepEqual(
        rows.map(({ id, status, title, failure, retry }) => ({
          id,
          status,
          title,
          failure,
          retry,
        })),
        [
          {
            id: rows[0]!.id,
            status: "running",
            title: "Provider retry",
            failure: retrying,
            retry: firstRetry,
          },
          {
            id: rows[0]!.id,
            status: "running",
            title: "Provider retry",
            failure: retrying,
            retry: lastRetry,
          },
          {
            id: rows[0]!.id,
            status: "failed",
            title: "Usage limit reached",
            failure: failed,
            retry: lastRetry,
          },
        ],
      );
      const { startedAt, ordinal } = rows[0]!;
      assert.ok(startedAt);
      assert.deepEqual(
        rows.map((row) => ({ startedAt: row.startedAt, ordinal: row.ordinal })),
        rows.map(() => ({ startedAt, ordinal })),
      );
      assert.isAtLeast(
        DateTime.toEpochMillis(rows[2]!.updatedAt) - DateTime.toEpochMillis(startedAt),
        5_000,
      );
      assert.deepInclude(seen.at(-1), {
        type: "turn.terminal",
        status: "failed",
        failure: failed,
        failureItemOrdinal: ordinal,
        retry: lastRetry,
        retryStartedAt: startedAt,
      });
    }).pipe(Effect.scoped),
  );
  it.effect("reports each directory's own limit for a model its project config changed", () =>
    Effect.gen(function* () {
      const custom = "/work/opencode2-custom";
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        ...opening,
        out("model.list", { "location[directory]": custom }),
        reply("model.list", {
          location: { directory: custom },
          data: modelCatalog.data.map((model) => ({
            ...model,
            limit: { context: 64000, input: 48000, output: 8000 },
          })),
        }),
        out("session.create", {
          location: { directory: custom },
          model: { providerID: "opencode", id: "big-pickle" },
          permissions: t3Rules,
        }),
        replyData("session.create", sessionInfo({ location: { directory: custom } })),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.step.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_0eb735d5b001oAFVeY5jz3WD4Z",
          finish: "stop",
          cost: 0,
          tokens: { input: 1200, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const customPolicy = { ...policy(), cwd: custom };
      const thread = yield* runtime.ensureThread({
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: customPolicy,
      });
      assert.deepEqual(thread.nativeMetadata?.modelSelection, {
        ...bigPickle,
        options: [{ id: "variant", value: "default" }],
      });
      assert.equal(runtime.getModelContextWindow?.(bigPickle, WORK), 160000);
      assert.equal(runtime.getModelContextWindow?.(bigPickle, custom), 48000);
      const settled = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.completedAt !== null,
        ),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* runtime.startTurn({ ...turnInput(thread), runtimePolicy: customPolicy });
      const turn = Option.getOrUndefined(yield* Fiber.join(settled));
      assert.equal(
        turn?.type === "provider_turn.updated" ? turn.providerTurn.tokenUsage?.maxTokens : null,
        48000,
      );
    }).pipe(Effect.scoped),
  );
  it.effect("rejects unreadable rollback history before cutting the native session", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("message.list", { sessionID: SESSION, limit: "100", type: undefined }),
        reply("message.list", {
          data: [
            { id: "msg_kept", time: { created: 1 }, text: "first", type: "user" },
            {
              id: "msg_compaction",
              time: { created: 2 },
              type: "compaction",
              status: "completed",
              reason: "auto",
              summary: "First turn summary",
              recent: 42,
            },
            { id: "msg_dropped", time: { created: 3 }, text: "second", type: "user" },
          ],
          cursor: {},
        }),
      ]);
      const now = yield* DateTime.now;
      const turns = ["msg_kept", "msg_dropped"].map((nativeId, index) => ({
        id: ProviderTurnId.make(`provider-turn:rollback-history:${index}`),
        providerThreadId: thread.id,
        nodeId: NodeId.make(`node:rollback-history:${index}`),
        runAttemptId: RunAttemptId.make(`attempt:rollback-history:${index}`),
        nativeTurnRef: { driver: OPENCODE_PROVIDER, nativeId, strength: "weak" as const },
        ordinal: index + 1,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      }));
      const failure = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:rollback-history"),
            appRunOrdinal: 1,
            providerTurn: turns[0]!,
          },
          providerThreadTurns: turns,
        })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterRollbackThreadError");
      assert.include(Cause.pretty(Cause.fail(failure)), '["recent"]');
    }).pipe(Effect.scoped),
  );
  it.effect("clears a staged revert whose commit failed, before the next prompt too", () =>
    Effect.gen(function* () {
      const kept = "msg_t3_turn_run-attempt:kept:1";
      const dropped = "msg_t3_turn_run-attempt:dropped:1";
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
        out("session.revert.clear", { sessionID: SESSION }),
        reply("session.revert.clear", {
          status: 500,
          body: { _tag: "UnknownError", message: "busy" },
        }),
        out("session.revert.clear", { sessionID: SESSION }),
        reply("session.revert.clear", null),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("session.prompt", { sessionID: SESSION, id: "<any>", text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
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
      yield* runtime.startTurn(turnInput(thread));
      assert.equal((yield* terminalOf(runtime))?.status, "completed");
    }).pipe(Effect.scoped),
  );
});
