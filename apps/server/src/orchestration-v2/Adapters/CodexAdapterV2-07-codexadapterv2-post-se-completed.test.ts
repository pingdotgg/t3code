import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexError from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import { MCP_APP_OUTPUT_KEY, readMcpAppReference } from "@t3tools/shared/mcpApp";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import packageJson from "../../../package.json" with { type: "json" };
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import { resolveProviderCompatibility } from "../../provider/providerCompatibility.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";
import * as CodexAdapterV2Testkit from "./CodexAdapterV2.testkit.ts";

import {
  encodeUnknownJson,
  makeCodexTestTurnInput,
  makeCodexReplayTurn,
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayHarness,
  assistantMessages,
  finalAnswerTranscript,
  BG_NATIVE_THREAD,
  BG_NATIVE_TURN,
  BG_COMMAND_ITEM,
  BG_PROMPT,
  backgroundCommandItem,
  backgroundExecTranscript,
  nativeThreadId,
  notification,
  nativeTurnId,
  prompt,
} from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect.each(["completed", "interrupted"] as const)(
    "retains Codex reasoning parts when the turn is %s",
    (terminalStatus) =>
      Effect.scoped(
        Effect.gen(function* () {
          const scenario = `codex-reasoning-${terminalStatus}`;
          const nativeThreadId = `native-${scenario}-thread`;
          const nativeTurnId = `native-${scenario}-turn`;
          const prompt = "Explain the check.";
          const transcript = makeCodexReplayTranscript({
            scenario,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
              ...[
                {
                  method: "item/reasoning/summaryTextDelta",
                  params: { itemId: "thought", summaryIndex: 0, delta: "Summary " },
                },
                {
                  method: "item/reasoning/summaryTextDelta",
                  params: { itemId: "thought", summaryIndex: 0, delta: "one" },
                },
                {
                  method: "item/reasoning/summaryTextDelta",
                  params: { itemId: "thought", summaryIndex: 1, delta: "Summary two" },
                },
                {
                  method: "item/reasoning/textDelta",
                  params: { itemId: "thought", contentIndex: 0, delta: "Raw trace" },
                },
                {
                  method: "item/completed",
                  params: {
                    item: {
                      type: "commandExecution",
                      id: "after-thought",
                      command: "pwd",
                      cwd: "/workspace",
                      processId: "42",
                      source: "unifiedExecStartup",
                      status: "completed",
                      commandActions: [{ type: "unknown", command: "pwd" }],
                      aggregatedOutput: "/workspace",
                      exitCode: 0,
                      durationMs: 1,
                    },
                  },
                },
                ...(terminalStatus === "completed"
                  ? [
                      {
                        method: "item/completed",
                        params: {
                          item: {
                            type: "reasoning",
                            id: "thought",
                            summary: ["Final summary one", "Summary two"],
                            content: ["Raw trace"],
                          },
                        },
                      },
                      {
                        method: "item/completed",
                        params: {
                          item: {
                            type: "reasoning",
                            id: "completion-only",
                            summary: ["Completion without deltas"],
                            content: [],
                          },
                        },
                      },
                      {
                        method: "item/reasoning/textDelta",
                        params: {
                          itemId: "delta-only",
                          contentIndex: 0,
                          delta: "Retained when completion omits content",
                        },
                      },
                      {
                        method: "item/completed",
                        params: {
                          item: { type: "reasoning", id: "delta-only", summary: [], content: [] },
                        },
                      },
                    ]
                  : []),
              ].map((event, index) => ({
                type: "emit_inbound" as const,
                label: `reasoning-${index}`,
                frame: {
                  method: event.method,
                  params: { threadId: nativeThreadId, turnId: nativeTurnId, ...event.params },
                },
              })),
              {
                type: "emit_inbound",
                label: "turn/completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: nativeTurnId, status: terminalStatus }),
                  },
                },
              },
            ],
          });
          const harness = yield* makeCodexReplayHarness(transcript);
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`attempt-${scenario}`),
              text: prompt,
            }),
          );
          yield* harness.firstTerminal;
          const latest = new Map(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "reasoning"
                ? [[event.turnItem.id, event.turnItem] as const]
                : [],
            ),
          );
          assert.deepEqual(
            [...latest.values()].map((item) => item.text),
            terminalStatus === "completed"
              ? [
                  "Final summary one",
                  "Summary two",
                  "Raw trace",
                  "Completion without deltas",
                  "Retained when completion omits content",
                ]
              : ["Summary one", "Summary two", "Raw trace"],
          );
          assert.isTrue([...latest.values()].every((item) => item.status === terminalStatus));
          assert.isTrue([...latest.values()].every((item) => item.streaming === false));
          assert.isTrue(
            [...latest.values()].every(
              (item) => item.runId !== null && item.providerTurnId !== null,
            ),
          );
          assert.equal(new Set([...latest.values()].map((item) => item.ordinal)).size, latest.size);
          const command = harness.events.find(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          );
          assert.isDefined(command);
          if (command?.type === "turn_item.updated") {
            assert.isTrue(
              [...latest.values()]
                .slice(0, 3)
                .every((item) => item.ordinal < command.turnItem.ordinal),
            );
          }
          assert.deepEqual(assistantMessages(harness.events), []);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
  );
  it.effect.each([false, true])(
    "preserves a final answer that repeats a preceding partial answer (streamed: %s)",
    (streamed) =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = finalAnswerTranscript("codex-partial-then-final", [
            { id: "partial", text: "CODEX_RECOVERY_OK", phase: "partial_answer", streamed },
            { id: "final", text: "CODEX_RECOVERY_OK", phase: "final_answer", streamed },
          ]);
          const harness = yield* makeCodexReplayHarness(transcript);
          const now = yield* DateTime.now;
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-partial-then-final"),
              text: "Reply with the requested recovery marker.",
            }),
          );
          yield* harness.awaitTerminal(1);
          assert.deepEqual(
            assistantMessages(harness.events).map((event) => event.message.text),
            ["CODEX_RECOVERY_OK", "CODEX_RECOVERY_OK"],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
  );
  it.effect.each([
    {
      name: "a text reply gains each saved image once",
      reply: "Done.",
      images: [
        { savedPath: "/tmp/a.png" },
        { savedPath: "/tmp/a.png" },
        { savedPath: "/tmp/failed.png", status: "failed" },
        {
          savedPath: "/tmp/limited.png",
          failure: { type: "usageLimitExceeded", limitId: "image-generation" },
        },
        { savedPath: null },
      ],
      expected: "Done.\n\n![](</tmp/a.png>)",
    },
    {
      name: "an image-only result becomes the reply",
      reply: null,
      images: [{ savedPath: "/tmp/a.png" }],
      expected: "![](</tmp/a.png>)",
    },
  ])("projects generated images: $name", ({ reply, images, expected }) =>
    Effect.gen(function* () {
      const scenario = "codex-generated-images";
      const result = "aW1hZ2UtYnl0ZXMtbXVzdC1uZXZlci1yZWFjaC1jbGllbnRz";
      const base = finalAnswerTranscript(
        scenario,
        reply === null ? [] : [{ id: "answer", text: reply }],
      );
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario,
          entries: [
            ...base.entries.slice(0, -1),
            ...images.map((image, index) => ({
              type: "emit_inbound" as const,
              frame: {
                method: "item/completed",
                params: {
                  threadId: `native-${scenario}-thread`,
                  turnId: `native-${scenario}-turn`,
                  item: {
                    type: "imageGeneration",
                    id: `image-${index}`,
                    status: "completed",
                    result,
                    ...image,
                  },
                },
              },
            })),
            ...base.entries.slice(-1),
          ],
        }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-generated-images"),
          text: "Reply with the requested recovery marker.",
        }),
      );
      yield* harness.firstTerminal;

      const messages = assistantMessages(harness.events);
      assert.strictEqual(messages.at(-1)?.message.text, expected);
      assert.strictEqual(messages.at(-1)?.message.streaming, false);
      assert.strictEqual(new Set(messages.map(({ message }) => message.id)).size, 1);
      // Image bytes stay with Codex; clients load the saved file.
      assert.notInclude(encodeUnknownJson(harness.events), result);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );
  it.effect.each(["complete", "stop"] as const)(
    "retains generating images after settlement until %s",
    (outcome) =>
      Effect.gen(function* () {
        const scenario = "codex-retained-image";
        const base = finalAnswerTranscript(scenario, [{ id: "answer", text: "Done." }]);
        const completions = {
          first: yield* Deferred.make<void>(),
          second: yield* Deferred.make<void>(),
        };
        const projected = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        const firstText = "Done.\n\n![](</tmp/first.png>)";
        const imageEvent = (image: "first" | "second", phase: "started" | "completed") => ({
          type: "emit_inbound" as const,
          label: `${image}-${phase}`,
          frame: {
            method: `item/${phase}`,
            params: {
              threadId: `native-${scenario}-thread`,
              turnId: `native-${scenario}-turn`,
              item: {
                type: "imageGeneration",
                id: image,
                status: phase === "started" ? "inProgress" : "completed",
                result: "",
                ...(phase === "completed" ? { savedPath: `/tmp/${image}.png` } : {}),
              },
            },
          },
        });
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario,
            entries: [
              ...base.entries.slice(0, -2),
              imageEvent("first", "started"),
              imageEvent("second", "started"),
              ...base.entries.slice(-2),
              imageEvent("first", "completed"),
              imageEvent("second", "completed"),
            ],
          }),
          (event) =>
            event.type === "message.updated" && event.message.text === firstText
              ? Deferred.succeed(projected, undefined)
              : event.type === "background_work.updated" && !event.pending
                ? Deferred.succeed(drained, undefined)
                : Effect.void,
          undefined,
          undefined,
          (entry) =>
            entry.label === "first-completed"
              ? Deferred.await(completions.first)
              : entry.label === "second-completed"
                ? Deferred.await(completions.second)
                : Effect.void,
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-retained-image"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* harness.firstTerminal;
        const pending = Effect.all([
          harness.runtime.hasPendingBackgroundWorkForThread!(harness.providerThread),
          harness.hasPendingBackgroundWork,
        ]);
        assert.deepEqual(yield* pending, [true, true]);
        assert.strictEqual(assistantMessages(harness.events).at(-1)?.message.text, "Done.");
        const cleared = () =>
          harness.events.some((e) => e.type === "background_work.updated" && !e.pending);

        if (outcome === "complete") {
          yield* Deferred.succeed(completions.first, undefined);
          yield* Deferred.await(projected);
          // The second image is still generating, so the first must not release the turn.
          assert.deepEqual(yield* pending, [true, true]);
          assert.isFalse(cleared());
          yield* Deferred.succeed(completions.second, undefined);
        } else {
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: harness.terminalEvents()[0]!.providerTurnId,
            requestRuntimeRestart: true,
          });
        }
        yield* Deferred.await(drained);
        assert.deepEqual(yield* pending, [false, false]);
        assert.lengthOf(harness.terminalEvents(), 1);
        // Run ingestion follows these updates, so they must bracket the terminal and the images.
        const indexOf = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
          harness.events.findIndex(predicate);
        const started = indexOf((e) => e.type === "background_work.updated" && e.pending);
        const terminal = indexOf((e) => e.type === "turn.terminal");
        const finished = indexOf((e) => e.type === "background_work.updated" && !e.pending);
        assert.isAtLeast(started, 0);
        assert.isAbove(terminal, started);
        assert.isAbove(finished, terminal);
        if (outcome === "complete") {
          const messages = assistantMessages(harness.events);
          const projectedBoth = indexOf(
            (e) =>
              e.type === "message.updated" &&
              e.message.text === `${firstText}\n\n![](</tmp/second.png>)`,
          );
          assert.isAbove(projectedBoth, terminal);
          assert.isAbove(finished, projectedBoth);
          assert.strictEqual(messages.at(-1)?.message.id, messages[0]?.message.id);
          assert.strictEqual(messages.at(-1)?.message.streaming, false);
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );
  it.effect("suppresses a trailing empty final answer after a non-empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-redundant-empty-final", [
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-redundant-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* harness.awaitTerminal(1);

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );
  it.effect("wakes with well-formed text when the cuts split an emoji", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "codex-bg-wake-surrogate",
            entries: [
              ...backgroundExecTranscript.entries.slice(0, -1),
              {
                type: "emit_inbound",
                label: "item/completed/command-late",
                frame: {
                  method: "item/completed",
                  params: {
                    item: {
                      ...backgroundCommandItem("completed"),
                      command: `${"c".repeat(199)}🚀`,
                      aggregatedOutput: `🚀${"x".repeat(999)}\n`,
                    },
                    threadId: BG_NATIVE_THREAD,
                    turnId: BG_NATIVE_TURN,
                    completedAtMs: 1782622465500,
                  },
                },
              },
            ],
          }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-bg-wake-surrogate"),
            text: BG_PROMPT,
          }),
        );
        yield* harness.until(() => harness.continuationRequests.length > 0);
        assert.isTrue(harness.continuationRequests[0]?.detail?.isWellFormed());
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );
  it.effect.each([false, true])(
    "keeps commands interrupted after native thread closure (persistent tool: %s)",
    (retainContext) =>
      Effect.gen(function* () {
        const notification = (method: string, params: unknown) => ({
          type: "emit_inbound" as const,
          label: method,
          frame: { method, params },
        });
        const monitor = (status: "inProgress" | "completed") =>
          notification(status === "inProgress" ? "item/started" : "item/completed", {
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            item: {
              type: "dynamicToolCall",
              id: "persistent-monitor",
              namespace: "grok",
              tool: "monitor",
              status,
              arguments: { persistent: true, command: "tail -f" },
            },
          });
        // Replies fence notification handling on the same protocol reader.
        const unsubscribe = (id: number, notifications: ReturnType<typeof notification>[] = []) => [
          {
            type: "expect_outbound" as const,
            label: `unsubscribe-${id}`,
            frame: { id, method: "thread/unsubscribe", params: { threadId: BG_NATIVE_THREAD } },
          },
          ...notifications,
          {
            type: "emit_inbound" as const,
            label: `unsubscribe-result-${id}`,
            frame: { id, result: { status: "notSubscribed" } },
          },
        ];
        const closed = notification("thread/closed", { threadId: BG_NATIVE_THREAD });
        const transcript = makeCodexReplayTranscript({
          scenario: `codex-background-thread-closed-${retainContext}`,
          entries: [
            ...backgroundExecTranscript.entries.slice(0, -2),
            ...(retainContext ? [monitor("inProgress")] : []),
            backgroundExecTranscript.entries.at(-2)!,
            ...unsubscribe(4),
            ...unsubscribe(5, [notification("thread/closed", { threadId: "unrelated-thread" })]),
            ...unsubscribe(6, [closed]),
            ...unsubscribe(7, [
              closed,
              notification("item/completed", {
                threadId: BG_NATIVE_THREAD,
                turnId: BG_NATIVE_TURN,
                item: backgroundCommandItem("completed"),
              }),
              ...(retainContext ? [monitor("completed")] : []),
            ]),
          ],
        });
        const interrupted = yield* Deferred.make<void>();
        const monitorCompleted = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(transcript, (event) => {
          if (event.type !== "turn_item.updated") return Effect.void;
          if (
            event.turnItem.nativeItemRef?.nativeId === BG_COMMAND_ITEM &&
            event.turnItem.status === "interrupted"
          ) {
            return Deferred.succeed(interrupted, undefined);
          }
          return event.turnItem.nativeItemRef?.nativeId === "persistent-monitor" &&
            event.turnItem.status === "completed"
            ? Deferred.succeed(monitorCompleted, undefined)
            : Effect.void;
        });
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-thread-closed"),
            text: BG_PROMPT,
          }),
        );
        yield* harness.firstTerminal;
        const unload = harness.runtime.unloadThread!({ providerThread: harness.providerThread });
        yield* unload;
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        yield* unload;
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        yield* unload;
        assert.equal(yield* harness.hasPendingBackgroundWork, retainContext);
        yield* Deferred.await(interrupted);
        yield* unload;
        if (retainContext) yield* Deferred.await(monitorCompleted);
        assert.deepEqual(
          {
            items: harness.events.flatMap((event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === BG_COMMAND_ITEM
                ? [event.turnItem.status]
                : [],
            ),
            nodes: harness.events.flatMap((event) =>
              event.type === "node.updated" &&
              event.node.nativeItemRef?.nativeId === BG_COMMAND_ITEM
                ? [event.node.status]
                : [],
            ),
            roots: harness.terminalEvents().map((event) => event.status),
            continuations: harness.continuationRequests.length,
          },
          {
            items: ["running", "interrupted"],
            nodes: ["running", "interrupted"],
            roots: ["completed"],
            continuations: 0,
          },
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.isFalse(
          yield* harness.runtime.hasPendingBackgroundWorkForThread!(harness.providerThread),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );
});
