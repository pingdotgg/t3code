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
  encodeReplayTranscriptJson,
  decodeReplayTranscriptJson,
  encodeStringJson,
  providerThreadId,
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeCodexTestTurnInput,
  makeCodexReplayTurn,
  codexReplayPreamble,
  makeCodexReplayTranscript,
  withReplayRequestId,
  makeCodexReplayHarness,
  nativeThreadId,
  nativeTurnId,
  prompt,
} from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect.each([
    "recover",
    "completion-only",
    "exhaust",
    "stop",
    "stop-continued",
    "stop-starting",
    "started-first",
    "completed-first",
    "new-run",
    "steer",
    "start-fails",
  ] as const)("handles terminal Codex capacity failures when retries %s", (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = `capacity-${outcome}`;
        const nativeThreadId = `native-${scenario}`;
        const nativeTurnId = (attempt: number) => `${nativeThreadId}-${attempt}`;
        const prompt = "Continue the task.";
        const capacityError = {
          message: "Selected model is at capacity. Please try a different model.",
          codexErrorInfo: "serverOverloaded",
        };
        const failureEntries = (attempt: number): Array<CodexReplay.CodexAppServerReplayEntry> => [
          {
            type: "emit_inbound",
            frame: {
              method: "error",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId(attempt),
                willRetry: false,
                error: capacityError,
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId(attempt), status: "failed" }),
                  error: capacityError,
                },
              },
            },
          },
        ];
        const entries = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: nativeTurnId(0),
          prompt,
        });
        entries.push(
          ...(outcome === "completion-only" ? failureEntries(0).slice(1) : failureEntries(0)),
        );
        if (outcome === "completion-only") entries.push(...failureEntries(0).slice(1));
        const retries = outcome === "exhaust" ? 5 : outcome === "stop" ? 0 : 1;
        const steeredText = "Use the smaller change.";
        for (let attempt = 1; attempt <= retries; attempt++) {
          const start = codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: nativeTurnId(attempt),
            prompt,
          }).slice(-3);
          if (
            outcome === "started-first" ||
            outcome === "stop-starting" ||
            outcome === "completed-first" ||
            outcome === "new-run"
          ) {
            start.splice(1, 0, ...start.splice(2, 1));
          }
          for (const entry of start) {
            if (entry.type === "expect_outbound") {
              entries.push({
                ...entry,
                frame: {
                  id: 3 + attempt,
                  method: "turn/start",
                  params: {
                    threadId: nativeThreadId,
                    input: [],
                    cwd: "/workspace",
                    model: "gpt-5.4",
                    approvalPolicy: "never",
                    approvalsReviewer: "user",
                    sandboxPolicy: { type: "dangerFullAccess" },
                    summary: "detailed",
                    collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                  },
                },
              });
            } else if (entry.type === "emit_inbound" && entry.label === "turn/start") {
              if (outcome === "completed-first" || outcome === "new-run")
                entries.push({
                  type: "emit_inbound",
                  frame: {
                    method: "turn/completed",
                    params: {
                      threadId: nativeThreadId,
                      turn: makeCodexReplayTurn({ id: nativeTurnId(attempt), status: "completed" }),
                    },
                  },
                });
              if (outcome === "new-run") {
                entries.push(
                  ...codexReplayPreamble({
                    nativeThreadId,
                    nativeTurnId: nativeTurnId(2),
                    prompt: "Next task.",
                  })
                    .slice(-3)
                    .map((next, index) => (index < 2 ? withReplayRequestId(next, 5) : next)),
                  ...failureEntries(2),
                );
              }
              entries.push(
                outcome === "start-fails"
                  ? {
                      type: "emit_inbound",
                      frame: {
                        id: 3 + attempt,
                        error: { code: -32603, message: "Start failed" },
                      },
                    }
                  : withReplayRequestId(entry, 3 + attempt),
              );
            } else if (outcome !== "start-fails") {
              entries.push(
                outcome === "stop-starting" && entry.type === "emit_inbound"
                  ? { ...entry, afterMs: 1_000 }
                  : entry,
              );
              if (outcome === "stop-starting") {
                entries.push(
                  {
                    type: "expect_outbound",
                    frame: {
                      id: 5,
                      method: "turn/interrupt",
                      params: { threadId: nativeThreadId, turnId: nativeTurnId(attempt) },
                    },
                  },
                  { type: "emit_inbound", frame: { id: 5, result: {} } },
                );
              }
            }
          }
          if (outcome === "exhaust") entries.push(...failureEntries(attempt));
          if (
            outcome === "recover" ||
            outcome === "completion-only" ||
            outcome === "started-first" ||
            outcome === "stop-starting"
          ) {
            entries.push({
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({
                    id: nativeTurnId(attempt),
                    status: outcome === "stop-starting" ? "interrupted" : "completed",
                  }),
                },
              },
            });
          }
          if (outcome === "stop-continued" || outcome === "steer") {
            const steering = outcome === "steer";
            entries.push(
              {
                type: "expect_outbound",
                frame: {
                  id: 5,
                  method: steering ? "turn/steer" : "turn/interrupt",
                  params: steering
                    ? {
                        threadId: nativeThreadId,
                        expectedTurnId: nativeTurnId(attempt),
                        input: [{ type: "text", text: steeredText }],
                      }
                    : { threadId: nativeThreadId, turnId: nativeTurnId(attempt) },
                },
              },
              {
                type: "emit_inbound",
                frame: { id: 5, result: steering ? { turnId: nativeTurnId(attempt) } : {} },
              },
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({
                      id: nativeTurnId(attempt),
                      status: steering ? "completed" : "interrupted",
                    }),
                  },
                },
              },
            );
          }
        }
        const milestones = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const starts: Array<unknown> = [];
        const retryStarted = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({ scenario, entries }),
          (event) =>
            event.type === "turn.terminal" ||
            (event.type === "turn_item.updated" &&
              event.turnItem.type === "error" &&
              event.turnItem.status === "running")
              ? Queue.offer(milestones, event)
              : Effect.void,
          (method, params) =>
            Effect.gen(function* () {
              if (method === "turn/start") {
                starts.push(params);
                if (starts.length === 2) yield* Deferred.succeed(retryStarted, undefined);
              }
            }),
        );
        const turnInput = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(scenario),
          text: prompt,
        });
        yield* harness.runtime.startTurn(turnInput);
        for (let attempt = 1; attempt <= Math.max(retries, 1); attempt++) {
          const milestone = yield* Queue.take(milestones);
          assert.equal(milestone.type, "turn_item.updated");
          if (milestone.type !== "turn_item.updated" || milestone.turnItem.type !== "error") return;
          const providerTurnId = milestone.turnItem.providerTurnId;
          assert.isNotNull(providerTurnId);
          if (providerTurnId === null) return;
          assert.deepEqual(milestone.turnItem.retry, {
            attempt,
            maxAttempts: 5,
            retryDelayMs: Math.min(2_000 * 2 ** (attempt - 1), 30_000),
          });
          assert.isEmpty(harness.terminalEvents());
          if (outcome === "stop") {
            yield* harness.runtime.interruptTurn({
              providerThread: harness.providerThread,
              providerTurnId,
            });
          }
          const steering =
            outcome === "steer"
              ? yield* harness.runtime
                  .steerTurn({
                    ...turnInput,
                    providerTurnId,
                    message: { ...turnInput.message, text: steeredText },
                  })
                  .pipe(Effect.forkScoped)
              : undefined;
          yield* TestClock.adjust(Math.min(2_000 * 2 ** (attempt - 1), 30_000));
          if (outcome === "stop-starting") {
            yield* Deferred.await(retryStarted);
            const stopping = yield* harness.runtime
              .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
              .pipe(Effect.forkScoped);
            yield* TestClock.adjust("1 second");
            yield* Fiber.join(stopping);
          }
          if (steering !== undefined) yield* Fiber.join(steering);
          if (outcome === "stop-continued") {
            yield* harness.until(() =>
              harness.events.some(
                (event) =>
                  event.type === "provider_turn.updated" &&
                  event.providerTurn.nativeTurnRef?.nativeId === nativeTurnId(1),
              ),
            );
            yield* harness.runtime.interruptTurn({
              providerThread: harness.providerThread,
              providerTurnId,
            });
          }
        }
        yield* harness.awaitTerminal(1);
        if (outcome === "new-run") {
          assert.equal((yield* Queue.take(milestones)).type, "turn.terminal");
          yield* harness.runtime.startTurn({
            ...turnInput,
            attemptId: RunAttemptId.make("capacity-next-task"),
            message: { ...turnInput.message, text: "Next task." },
          });
          const nextRetry = yield* Queue.take(milestones);
          assert.equal(nextRetry.type, "turn_item.updated");
          if (nextRetry.type !== "turn_item.updated" || nextRetry.turnItem.type !== "error") return;
          assert.equal(nextRetry.turnItem.retry?.attempt, 1);
          return;
        }
        const terminal = harness.terminalEvents()[0];
        assert.equal(
          terminal?.status,
          outcome === "recover" ||
            outcome === "completion-only" ||
            outcome === "steer" ||
            outcome === "started-first" ||
            outcome === "completed-first"
            ? "completed"
            : outcome === "stop" || outcome === "stop-continued" || outcome === "stop-starting"
              ? "interrupted"
              : "failed",
        );
        assert.lengthOf(starts, 1 + retries);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "running",
          ),
          outcome === "start-fails" ? 1 : 1 + retries,
        );
        const retryItems = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "error"
            ? [event.turnItem]
            : [],
        );
        assert.isTrue(
          ["completed", "failed", "interrupted"].includes(retryItems.at(-1)?.status ?? ""),
        );
        assert.lengthOf(new Set(retryItems.map((item) => item.id)), 1);

        if (outcome === "recover") {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-capacity-retry-" });
          const localTranscript = yield* decodeReplayTranscriptJson(
            (yield* encodeReplayTranscriptJson(
              makeCodexReplayTranscript({ scenario, entries }),
            )).replaceAll(yield* encodeStringJson("/workspace"), yield* encodeStringJson(cwd)),
          );
          const driver = yield* CodexReplay.makeReplayDriver(localTranscript);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const threadId = ThreadId.make("thread:capacity-retry");
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("create-capacity-retry"),
              threadId,
              projectId: ProjectId.make("project:capacity-retry"),
              title: "Capacity retry",
              modelSelection: CODEX_TEST_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            });
            const retrying = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "turn-item.updated" &&
                  event.payload.type === "error" &&
                  event.payload.retry != null &&
                  event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.forkChild({ startImmediately: true }),
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("start-capacity-retry"),
              threadId,
              messageId: MessageId.make("message:capacity-retry"),
              text: prompt,
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "start_immediately" },
            });
            yield* worker.drain();
            yield* Fiber.join(retrying);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
              "running",
            );
            const completed = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) => event.type === "run.updated" && event.payload.status === "waiting",
              ),
              Stream.runHead,
              Effect.forkChild({ startImmediately: true }),
            );
            yield* TestClock.adjust("2 seconds");
            yield* Fiber.join(completed);
            yield* worker.drain();
            const projection = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(projection.runs.at(-1)?.status, "completed");
            assert.deepEqual(
              projection.providerTurns.map((turn) => turn.status),
              ["failed", "completed"],
            );
            assert.lengthOf(
              projection.messages.filter((message) => message.role === "user"),
              1,
            );
            assert.isNull((yield* Ref.get(driver.state)).failure);
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                { name: "codex-capacity-retry", runtimePolicyOverride: { cwd } },
                CodexAdapterV2Testkit.layer({ transcript: localTranscript, driver }),
                { runEffectWorker: false },
              ),
            ),
          );
        }
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
  it.effect("reports a thread another Codex client is writing to as in use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "thread-open-elsewhere";
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "codex-resume-active-writer",
            entries: [
              ...codexReplayPreamble({
                nativeThreadId,
                nativeTurnId: "unused-turn",
                prompt: "unused-prompt",
              }).slice(0, 5),
              {
                type: "expect_outbound",
                label: "thread/resume",
                frame: {
                  id: 3,
                  method: "thread/resume",
                  params: {
                    threadId: nativeThreadId,
                    excludeTurns: true,
                    cwd: CODEX_TEST_RUNTIME_POLICY.cwd,
                    model: CODEX_TEST_MODEL_SELECTION.model,
                    config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "active writer",
                frame: {
                  id: 3,
                  error: {
                    code: -32600,
                    message: `thread ${nativeThreadId} already has an active writer`,
                  },
                },
              },
            ],
          }),
        );

        const error = yield* Effect.flip(
          harness.runtime.resumeThread({
            providerThread: harness.providerThread,
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          }),
        );

        assert.equal(error._tag, "ProviderAdapterThreadInUseError");
        assert.nestedPropertyVal(error, "providerThreadId", harness.providerThread.id);
        assert.include(error.message, "open in another Codex client");
        assert.nestedPropertyVal(
          error,
          "cause.errorMessage",
          `thread ${nativeThreadId} already has an active writer`,
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
  it.effect("resolves retryable app-server errors on resumed provider activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-provider-api-retry";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Open github.com.",
            }),
            {
              type: "emit_inbound",
              label: "error/retry",
              frame: {
                method: "error",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  willRetry: true,
                  error: {
                    message: "Reconnecting... 2/5",
                    additionalDetails: "The response stream disconnected.",
                    codexErrorInfo: {
                      responseStreamDisconnected: { httpStatusCode: 529 },
                    },
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/started/after-retry",
              frame: {
                method: "item/started",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  startedAtMs: 1782622445000,
                  item: {
                    type: "commandExecution",
                    id: "command-after-provider-retry",
                    command: "pwd",
                    cwd: "/workspace",
                    processId: "42",
                    source: "unifiedExecStartup",
                    status: "inProgress",
                    commandActions: [{ type: "unknown", command: "pwd" }],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/completed/after-retry",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622445010,
                  item: {
                    type: "commandExecution",
                    id: "command-after-provider-retry",
                    command: "pwd",
                    cwd: "/workspace",
                    processId: "42",
                    source: "unifiedExecStartup",
                    status: "completed",
                    commandActions: [{ type: "unknown", command: "pwd" }],
                    aggregatedOutput: "/workspace\n",
                    exitCode: 0,
                    durationMs: 10,
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-provider-api-retry"),
            text: "Open github.com.",
          }),
        );
        yield* harness.awaitTerminal(1);

        const retryItems = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.retry !== undefined
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(retryItems, 2);
        assert.equal(retryItems[0]?.status, "running");
        assert.equal(retryItems[0]?.failure.code, "responseStreamDisconnected");
        assert.deepEqual(retryItems[0]?.retry, {
          attempt: 2,
          maxAttempts: 5,
          retryDelayMs: null,
        });
        assert.equal(retryItems[1]?.id, retryItems[0]?.id);
        assert.equal(retryItems[1]?.status, "completed");
        assert.equal(retryItems[1]?.title, "Provider recovered");

        const recoveredIndex = harness.events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.status === "completed",
        );
        const resumedCommandIndex = harness.events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.input === "pwd",
        );
        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        assert.isAtLeast(recoveredIndex, 0);
        assert.isAbove(resumedCommandIndex, recoveredIndex);
        assert.isAbove(terminalIndex, resumedCommandIndex);
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
});
