// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";
import type {
  ElicitationRequest,
  Query as ClaudeQuery,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AskUserQuestionInput,
  TaskCreateInput,
  TaskCreateOutput,
  TaskListOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  type ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  CheckpointId,
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  type ResolvedProviderInstanceEnvironment,
  ProviderDriverKind,
  type ProviderReplayTranscript,
  type ProviderApprovalDecision,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Tool } from "effect/ai";
import { formatClaudeResumeCompactionQuestion } from "@t3tools/shared/claudeCompaction";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as PortScanner from "../../preview/PortScanner.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { WorkflowAgentTranscriptReadObserver } from "../workflowAgentTranscript.ts";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { PreviewControlsToolkit } from "../../mcp/toolkits/previewControls/tools.ts";
import { HtmlToolkit } from "../../mcp/toolkits/html/tools.ts";
import { EnvironmentToolkit } from "../../mcp/toolkits/environment/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { WorktreeToolkit } from "../../mcp/toolkits/worktree/tools.ts";
import { ThreadToolkit } from "../../mcp/toolkits/thread/tools.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import { ClaudeExecutableFileCheck } from "../../provider/Drivers/ClaudeExecutable.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ClaudeOrchestratorReplayHarness } from "./ClaudeAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../testkit/DeterministicRuntime.ts";
import { runOrchestratorV2Scenario } from "../testkit/OrchestratorScenario.ts";
import { layerProviderReplay } from "../testkit/ProviderReplayHarness.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
} from "../testkit/fixtures/shared.ts";

import {
  makeClaudeTestTurnInput,
  WAKE_NATIVE_SESSION,
  WAKE_TASK_ID,
  claudeSdkFrame,
  wakeTaskStarted,
  makeAssistantTextFrame,
  makeAssistantErrorFrame,
  makeResultFrame,
  turnOneResult,
  makeWakeHarness,
  makeTaskToolHarness,
  createTask,
  providerThreadRosterEvents,
} from "./ClaudeAdapterV2-fixtures.testkit.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect("does not associate structured task output with multiple tool results", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskToolHarness;
      yield* harness.startTurn();
      yield* harness.call(createTask("1", "Ambiguous"), { extraToolResult: true });
      yield* harness.finishTurn();
      assert.deepEqual(harness.plans(), []);
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
  it.effect("resolves API retries on resumed assistant activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-api-retry"),
            text: "Open github.com.",
            attachments: [],
          }),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "api_retry",
            attempt: 2,
            max_retries: 10,
            retry_delay_ms: 1_500,
            error_status: 529,
            error: "overloaded",
            uuid: "00000000-0000-4000-8000-000000000201",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const retryItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.retry !== undefined
              ? [event.turnItem]
              : [],
          );
        yield* harness.until(() => retryItems().length === 1);
        const runningRetry = retryItems()[0];
        assert.equal(runningRetry?.status, "running");
        assert.equal(runningRetry?.failure.code, "api_error_529");
        assert.deepEqual(runningRetry?.retry, {
          attempt: 2,
          maxAttempts: 10,
          retryDelayMs: 1_500,
        });

        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000202",
            text: "Opening GitHub.",
          }),
        );
        yield* harness.until(() => retryItems().length === 2);
        assert.lengthOf(harness.terminalEvents(), 0);
        const recoveredRetry = retryItems()[1];
        assert.equal(recoveredRetry?.id, runningRetry?.id);
        assert.equal(recoveredRetry?.status, "completed");
        assert.equal(recoveredRetry?.title, "Provider recovered");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000203",
            result: "Opened GitHub.",
          }),
        );
        yield* harness.awaitTerminal(1);
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
  it.effect.each(["api_error", "overloaded_status"] as const)(
    "fails a success-shaped Claude result with %s",
    (terminalReason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-structured-terminal-failure"),
              text: "Complete the task.",
              attachments: [],
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000205",
              result: "Provider failure details.",
              isError: false,
              ...(terminalReason === "overloaded_status"
                ? { apiErrorStatus: 529 }
                : { terminalReason }),
            }),
          );
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal.status, "failed");
          if (terminal.status !== "failed") return;
          assert.isNotEmpty(terminal.failure.message);
          assert.equal(terminal.failure.class, "provider_error");
          assert.isFalse(
            harness.events.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.text === "Provider failure details.",
            ),
          );
          assert.equal(
            terminal.failure.code,
            terminalReason === "overloaded_status" ? "api_error_529" : terminalReason,
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

  // Context exhaustion reports blocking_limit even when the rate-limit window is allowed.
  it.effect.each([
    {
      windowStatus: "allowed",
      expectedClass: "provider_error",
      expectedMessage: "Claude stopped: the prompt exceeds the model's context window.",
    },
    {
      windowStatus: "rejected",
      expectedClass: "usage_limit",
      expectedMessage: "Claude usage limit reached. Send the message again once the limit resets.",
    },
  ] as const)(
    "classifies blocking_limit by its rate-limit evidence ($windowStatus window)",
    ({ windowStatus, expectedClass, expectedMessage }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`attempt-blocking-limit-${windowStatus}`),
            text: "Continue.",
            attachments: [],
          }),
        );
        yield* Queue.offerAll(harness.sdkMessages, [
          claudeSdkFrame({
            type: "rate_limit_event",
            rate_limit_info: { status: windowStatus, rateLimitType: "five_hour" },
            uuid: "00000000-0000-4000-8000-000000000660",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeAssistantErrorFrame({
            uuid: "00000000-0000-4000-8000-000000000661",
            error: "invalid_request",
            text: "Prompt is too long",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000662",
            result: "Prompt is too long",
            isError: true,
            numTurns: 189,
            terminalReason: "blocking_limit",
          }),
        ]);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "failed");
        if (terminal.status !== "failed") return;
        assert.equal(terminal.failure.class, expectedClass);
        assert.include(terminal.failure.message, expectedMessage);
        assert.equal(terminal.failure.code, "blocking_limit");
        if (expectedClass === "provider_error") {
          assert.include(terminal.failure.message, "/compact");
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
  );
  it.effect(
    "uses task_started as an incremental roster fallback and clears on empty snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const emptyRoster = claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
            uuid: "00000000-0000-4000-8000-000000000202",
            session_id: WAKE_NATIVE_SESSION,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-roster-fallback"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
          yield* Queue.offer(harness.sdkMessages, turnOneResult);
          yield* harness.awaitTerminal(1);

          const afterStart = providerThreadRosterEvents(harness.events).filter(
            (event) => (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
          );
          assert.isAtLeast(afterStart.length, 1);
          assert.equal(
            (afterStart.at(-1)?.providerThread.pendingBackgroundTasks ?? [])[0]?.taskId,
            WAKE_TASK_ID,
          );

          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "system",
              subtype: "background_tasks_changed",
              tasks: [
                {
                  task_id: "subagent-shell",
                  task_type: "local_bash",
                  description: "sleep 150",
                  parent_task_id: "agent-1",
                },
              ],
              uuid: "00000000-0000-4000-8000-000000000203",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* harness.until(() =>
            providerThreadRosterEvents(harness.events).some(
              (event) =>
                event.providerThread.pendingBackgroundTasks?.[0]?.parentTaskId === "agent-1",
            ),
          );

          yield* Queue.offer(harness.sdkMessages, emptyRoster);
          yield* harness.until(() =>
            providerThreadRosterEvents(harness.events).some(
              (event) =>
                event.providerThread.status === "idle" &&
                (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
            ),
          );
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
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
  it.effect("holds only the background tasks the agent marks awaited, until they end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const awaitBackgroundTasks = harness.runtime.awaitBackgroundTasks;
        if (awaitBackgroundTasks === undefined) {
          throw new Error("Claude adapter runtime must expose awaitBackgroundTasks.");
        }
        const roster = (tasks: ReadonlyArray<string>, uuid: string) =>
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: tasks.map((taskId) => ({
              task_id: taskId,
              task_type: "local_bash",
              description: taskId,
            })),
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        const nextRoster = Effect.fn("nextRoster")(function* (
          matches: (tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>) => boolean,
        ) {
          while (true) {
            const { providerThread } = yield* Queue.take(harness.providerThreadReceipts);
            const tasks = providerThread.pendingBackgroundTasks ?? [];
            if (matches(tasks)) return tasks;
          }
        });
        const marks = (tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>) =>
          tasks.map((task) => [task.taskId, task.awaited === true]);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-awaited-roster"),
            text: "Run the tests in the background and the dev server.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          roster([WAKE_TASK_ID, "dev-server"], "00000000-0000-4000-8000-000000000301"),
        );
        yield* nextRoster((tasks) => tasks.length === 2);

        const marked = yield* awaitBackgroundTasks({
          providerThread: harness.providerThread,
          taskIds: [WAKE_TASK_ID, "already-finished"],
          awaited: true,
        });
        assert.deepStrictEqual(marked.matched, [WAKE_TASK_ID]);
        assert.deepStrictEqual(
          marks(yield* nextRoster((tasks) => tasks.some((task) => task.awaited === true))),
          [
            [WAKE_TASK_ID, true],
            ["dev-server", false],
          ],
        );
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* Queue.take(harness.terminalReceipts);

        // A replacing level rebuilds every entry; the mark must survive it.
        yield* Queue.offer(
          harness.sdkMessages,
          roster(["dev-server", WAKE_TASK_ID], "00000000-0000-4000-8000-000000000302"),
        );
        assert.deepStrictEqual(
          marks(yield* nextRoster((tasks) => tasks[0]?.taskId === "dev-server")),
          [
            ["dev-server", false],
            [WAKE_TASK_ID, true],
          ],
        );

        // Once the task leaves the roster, a reused id starts unmarked.
        yield* Queue.offer(
          harness.sdkMessages,
          roster(["dev-server"], "00000000-0000-4000-8000-000000000303"),
        );
        yield* nextRoster((tasks) => tasks.length === 1);
        yield* Queue.offer(
          harness.sdkMessages,
          roster(["dev-server", WAKE_TASK_ID], "00000000-0000-4000-8000-000000000304"),
        );
        assert.deepStrictEqual(marks(yield* nextRoster((tasks) => tasks.length === 2)), [
          ["dev-server", false],
          [WAKE_TASK_ID, false],
        ]);

        yield* awaitBackgroundTasks({
          providerThread: harness.providerThread,
          taskIds: ["dev-server"],
          awaited: true,
        });
        assert.deepStrictEqual(
          marks(yield* nextRoster((tasks) => tasks.some((task) => task.awaited === true))),
          [
            ["dev-server", true],
            [WAKE_TASK_ID, false],
          ],
        );
        const released = yield* awaitBackgroundTasks({
          providerThread: harness.providerThread,
          taskIds: ["dev-server"],
          awaited: false,
        });
        assert.deepStrictEqual(released.matched, ["dev-server"]);
        assert.deepStrictEqual(
          marks(yield* nextRoster((tasks) => !tasks.some((task) => task.awaited === true))),
          [
            ["dev-server", false],
            [WAKE_TASK_ID, false],
          ],
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
  it.effect("keeps a running Claude monitor typed after many newer monitors end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        let frameNumber = 0;
        const nextUuid = () => `00000000-0000-4000-8000-${String(++frameNumber).padStart(12, "0")}`;
        const monitorFrames = (index: number) => {
          const taskId = `monitor-task-${index}`;
          const toolUseId = `toolu_monitor_${index}`;
          const description = `Monitor ${index}`;
          return {
            taskId,
            start: [
              claudeSdkFrame({
                type: "assistant",
                message: {
                  model: "claude-sonnet-4-6",
                  id: `msg_monitor_${index}`,
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: toolUseId,
                      name: "Monitor",
                      input: { description, command: "sleep 8 && echo MONITOR_DONE" },
                    },
                  ],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
                parent_tool_use_id: null,
                uuid: nextUuid(),
                session_id: WAKE_NATIVE_SESSION,
              }),
              claudeSdkFrame({
                type: "system",
                subtype: "task_started",
                task_id: taskId,
                tool_use_id: toolUseId,
                description,
                is_backgrounded: true,
                task_type: "local_bash",
                uuid: nextUuid(),
                session_id: WAKE_NATIVE_SESSION,
              }),
              claudeSdkFrame({
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: toolUseId,
                      content: `Monitor started (task ${taskId}).`,
                    },
                  ],
                },
                parent_tool_use_id: null,
                uuid: nextUuid(),
                session_id: WAKE_NATIVE_SESSION,
                tool_use_result: { taskId, persistent: false },
              }),
            ],
            end: claudeSdkFrame({
              type: "system",
              subtype: "task_notification",
              task_id: taskId,
              tool_use_id: toolUseId,
              status: "completed",
              output_file: `/tmp/claude-replay/tasks/${taskId}.output`,
              summary: `Monitor "${description}" stream ended`,
              uuid: nextUuid(),
              session_id: WAKE_NATIVE_SESSION,
            }),
          };
        };

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-many-monitors"),
            text: "Watch the deploy, then re-arm short watches.",
            attachments: [],
          }),
        );
        const longRunning = monitorFrames(0);
        for (const frame of longRunning.start) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        for (let index = 1; index <= 65; index++) {
          const monitor = monitorFrames(index);
          for (const frame of monitor.start) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* Queue.offer(harness.sdkMessages, monitor.end);
        }
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [
              {
                task_id: longRunning.taskId,
                task_type: "local_bash",
                description: "Monitor 0",
              },
            ],
            uuid: nextUuid(),
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: nextUuid(), result: "Watching." }),
        );
        yield* harness.awaitTerminal(1);

        const roster = providerThreadRosterEvents(harness.events).at(-1)?.providerThread
          .pendingBackgroundTasks;
        assert.deepEqual(roster, [
          { taskId: longRunning.taskId, kind: "monitor", description: "Monitor 0" },
        ]);
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
