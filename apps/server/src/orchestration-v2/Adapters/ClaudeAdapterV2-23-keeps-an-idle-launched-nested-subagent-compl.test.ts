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
  claudeSdkFrame,
  makeAssistantTextFrame,
  makeResultFrame,
  yieldTicks,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
  makeSubagentAssistantFrames,
  makeSubagentToolResultFrame,
  makeSubagentTaskStartedFrame,
  makeSubagentNotificationFrame,
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
  it.effect("keeps an idle-launched nested subagent completed through a sibling's wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const OUTER_TASK_ID = "task-16355-outer";
        const OUTER_TOOL_USE_ID = "toolu-16355-outer";
        const NESTED_TASK_ID = "task-16355-nested";
        const NESTED_TOOL_USE_ID = "toolu-16355-nested";
        const SIBLING_TASK_ID = "task-16355-sibling";
        const SIBLING_TOOL_USE_ID = "toolu-16355-sibling";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const nestedStatuses = () =>
          harness.events.flatMap((event) =>
            event.type === "subagent.updated" &&
            event.subagent.nativeTaskRef?.nativeId === NESTED_TASK_ID
              ? [event.subagent.status]
              : [],
          );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-16355-1"),
            text: "Run two audits in the background.",
            attachments: [],
          }),
        );
        for (const frame of [
          makeSubagentTaskStartedFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000016301",
          }),
          makeSubagentTaskStartedFrame({
            taskId: SIBLING_TASK_ID,
            toolUseId: SIBLING_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000016302",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000016303",
            result: "Both audits run in the background.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);

        // The background subagent launches a foreground nested one while the root is idle.
        for (const frame of [
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_16355_nested_launch",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: NESTED_TOOL_USE_ID,
                  name: "Agent",
                  input: { description: "Nested check", prompt: "Sleep, then reply NESTED_OK" },
                },
              ],
            },
            parent_tool_use_id: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000016304",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: NESTED_TASK_ID,
            tool_use_id: NESTED_TOOL_USE_ID,
            description: "Nested check",
            subagent_type: "general-purpose",
            is_backgrounded: false,
            spawn_depth: 2,
            task_type: "local_agent",
            prompt: "Sleep, then reply NESTED_OK",
            uuid: "00000000-0000-4000-8000-000000016305",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: NESTED_TASK_ID,
            description: "Sleeping",
            uuid: "00000000-0000-4000-8000-000000016306",
            session_id: WAKE_NATIVE_SESSION,
          }),
        ]) {
          yield* harness.offerAndWait(frame);
        }

        // A user turn runs while the nested and then the outer subagent finish.
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-16355-2"),
            text: "Sleep for a while.",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* harness.until(() => harness.offeredMessages.length === 2);
        for (const frame of [
          makeSubagentNotificationFrame({
            taskId: NESTED_TASK_ID,
            toolUseId: NESTED_TOOL_USE_ID,
            summary: "NESTED_OK",
            uuid: "00000000-0000-4000-8000-000000016307",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000016308",
            toolUseId: NESTED_TOOL_USE_ID,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000016309",
            text: "OUTER_DONE",
          }),
          makeSubagentNotificationFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            summary: "OUTER_DONE",
            uuid: "00000000-0000-4000-8000-000000016310",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000016311",
            result: "Slept.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(2);

        // The sibling's completion wakes a continuation while the root is idle.
        for (const frame of [
          makeSubagentNotificationFrame({
            taskId: SIBLING_TASK_ID,
            toolUseId: SIBLING_TOOL_USE_ID,
            summary: "SIBLING_DONE",
            uuid: "00000000-0000-4000-8000-000000016312",
          }),
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000016313",
            text: "Both audits finished.",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000016314",
            result: "Both audits finished.",
            origin: { kind: "task-notification" },
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitContinuation(1);
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-16355-3"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(3);

        assert.equal(nestedStatuses().at(-1), "completed");
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
  it.effect.each(["exit", "Stop"] as const)(
    "settles a plain background subagent and its open call on %s after the root turn completes",
    (reason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const TOOL_USE_ID = "toolu-idle-exit";
          const BASH = "toolu-idle-exit-bash";
          const harness = yield* makeWakeHarnessWithOptions({ close: Queue.shutdown });
          const now = yield* DateTime.now;
          const bashStatuses = () =>
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === BASH
                ? [`${event.turnItem.type}:${event.turnItem.status}`]
                : [],
            );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-idle-exit"),
              text: "Audit in the background.",
              attachments: [],
            }),
          );
          yield* harness.offerAndWait(
            makeSubagentTaskStartedFrame({
              taskId: "task-idle-exit",
              toolUseId: TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000000981",
            }),
          );
          const started = yield* Queue.take(harness.subagentReceipts);
          assert.equal(started.subagent.status, "running");
          for (const frame of makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000982",
            bashToolUseId: BASH,
          })) {
            yield* harness.offerAndWait(frame);
          }
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000983",
              result: "Auditing in the background.",
            }),
          );
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal.status, "completed");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          assert.deepEqual(bashStatuses(), ["command_execution:running"]);

          if (reason === "Stop") {
            yield* harness.runtime.interruptTurn({
              providerThread: harness.providerThread,
              providerTurnId: terminal.providerTurnId,
              requestRuntimeRestart: true,
            });
          } else {
            yield* Queue.shutdown(harness.sdkMessages);
          }
          let ended = yield* Queue.take(harness.subagentReceipts);
          while (ended.subagent.status === "running") {
            ended = yield* Queue.take(harness.subagentReceipts);
          }
          assert.equal(ended.subagent.nativeTaskRef?.nativeId, "task-idle-exit");
          assert.equal(ended.subagent.status, reason === "Stop" ? "cancelled" : "failed");
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
          assert.deepEqual(bashStatuses(), [
            "command_execution:running",
            reason === "Stop" ? "command_execution:interrupted" : "command_execution:failed",
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
  it.effect.each(["before", "after"] as const)(
    "keeps a subagent call's result when the CLI exits before the drain (result %s the nested launch's)",
    (bashResultOrder) =>
      Effect.scoped(
        Effect.gen(function* () {
          const OUTER_TASK_ID = "task-exit-buffered-outer";
          const OUTER_TOOL_USE_ID = "toolu-exit-buffered-outer";
          const NESTED_TASK_ID = "task-exit-buffered-nested";
          const NESTED_TOOL_USE_ID = "toolu-exit-buffered-nested";
          const BASH = "toolu-exit-buffered-bash";
          const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
          const now = yield* DateTime.now;
          const bashItems = () =>
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === BASH
                ? [
                    `${event.turnItem.type}:${event.turnItem.status}:${JSON.stringify("input" in event.turnItem ? event.turnItem.input : null)}`,
                  ]
                : [],
            );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-exit-buffered-1"),
              text: "Audit in the background.",
              attachments: [],
            }),
          );
          for (const frame of [
            makeSubagentTaskStartedFrame({
              taskId: OUTER_TASK_ID,
              toolUseId: OUTER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001001",
            }),
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001002",
              result: "Auditing in the background.",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitTerminal(1);

          for (const frame of makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000001003",
            bashToolUseId: BASH,
          })) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.until(() => bashItems().length === 1);

          const bashResultFrame = makeSubagentToolResultFrame({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000001006",
            toolUseId: BASH,
          });
          for (const frame of [
            claudeSdkFrame({
              type: "assistant",
              message: {
                model: "claude-sonnet-4-6",
                id: "msg_exit_buffered_nested_launch",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: NESTED_TOOL_USE_ID,
                    name: "Agent",
                    input: { description: "Nested check", prompt: "Reply with NESTED_OK" },
                  },
                ],
              },
              parent_tool_use_id: OUTER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001004",
              session_id: WAKE_NATIVE_SESSION,
            }),
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: NESTED_TASK_ID,
              tool_use_id: NESTED_TOOL_USE_ID,
              description: "Nested check",
              subagent_type: "general-purpose",
              is_backgrounded: false,
              spawn_depth: 2,
              task_type: "local_agent",
              prompt: "Reply with NESTED_OK",
              uuid: "00000000-0000-4000-8000-000000001005",
              session_id: WAKE_NATIVE_SESSION,
            }),
            ...(bashResultOrder === "before" ? [bashResultFrame] : []),
            ...makeSubagentAssistantFrames({
              parentToolUseId: NESTED_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001007",
              text: "NESTED_OK",
            }),
            makeSubagentNotificationFrame({
              taskId: NESTED_TASK_ID,
              toolUseId: NESTED_TOOL_USE_ID,
              summary: "NESTED_OK",
              uuid: "00000000-0000-4000-8000-000000001008",
            }),
            makeSubagentToolResultFrame({
              parentToolUseId: OUTER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001009",
              toolUseId: NESTED_TOOL_USE_ID,
            }),
            ...(bashResultOrder === "after" ? [bashResultFrame] : []),
            makeSubagentNotificationFrame({
              taskId: OUTER_TASK_ID,
              toolUseId: OUTER_TOOL_USE_ID,
              summary: "OUTER_DONE",
              uuid: "00000000-0000-4000-8000-000000001010",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitContinuation(1);

          yield* Queue.shutdown(harness.sdkMessages);
          yield* yieldTicks(50);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-exit-buffered-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          assert.equal(harness.processQueues.length, 2);
          yield* Queue.offer(
            harness.processQueues[1]!,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001011",
              result: "The audit finished.",
            }),
          );
          yield* harness.awaitTerminal(2);

          const input = JSON.stringify("git log -5");
          assert.deepEqual(bashItems(), [
            `command_execution:running:${input}`,
            `command_execution:completed:${input}`,
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
  it.effect(
    "ends a subagent's SendMessage with its result when the CLI exits while the resume waits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const SENDER_TASK_ID = "task-exit-resume-sender";
          const SENDER_TOOL_USE_ID = "toolu-exit-resume-sender";
          const RESUMED_TASK_ID = "task-exit-resume-target";
          const RESUMED_TOOL_USE_ID = "toolu-exit-resume-target";
          const SEND = "toolu-exit-resume-sendmessage";
          const SEND_INPUT = { to: RESUMED_TASK_ID, message: "Check the last commit again." };
          const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
          const now = yield* DateTime.now;
          const sendItems = () =>
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === SEND
                ? [
                    `${event.turnItem.type}:${event.turnItem.status}:${JSON.stringify("input" in event.turnItem ? event.turnItem.input : null)}`,
                  ]
                : [],
            );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-exit-resume-1"),
              text: "Run two auditors in the background.",
              attachments: [],
            }),
          );
          for (const frame of [
            makeSubagentTaskStartedFrame({
              taskId: SENDER_TASK_ID,
              toolUseId: SENDER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001101",
            }),
            makeSubagentTaskStartedFrame({
              taskId: RESUMED_TASK_ID,
              toolUseId: RESUMED_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001102",
            }),
            makeSubagentNotificationFrame({
              taskId: RESUMED_TASK_ID,
              toolUseId: RESUMED_TOOL_USE_ID,
              summary: "First answer.",
              uuid: "00000000-0000-4000-8000-000000001103",
            }),
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001104",
              result: "Auditing in the background.",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitTerminal(1);

          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "assistant",
              message: {
                model: "claude-sonnet-4-6",
                id: "msg_exit_resume_sendmessage",
                type: "message",
                role: "assistant",
                content: [{ type: "tool_use", id: SEND, name: "SendMessage", input: SEND_INPUT }],
              },
              parent_tool_use_id: SENDER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001105",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* harness.until(() => sendItems().length >= 1);

          for (const frame of [
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: RESUMED_TASK_ID,
              tool_use_id: SEND,
              description: "Audit recent commits",
              is_backgrounded: true,
              task_type: "local_agent",
              prompt: SEND_INPUT.message,
              uuid: "00000000-0000-4000-8000-000000001106",
              session_id: WAKE_NATIVE_SESSION,
            }),
            claudeSdkFrame({
              type: "user",
              message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: SEND, content: "Message sent." }],
              },
              parent_tool_use_id: SENDER_TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000001107",
              session_id: WAKE_NATIVE_SESSION,
            }),
            makeSubagentNotificationFrame({
              taskId: RESUMED_TASK_ID,
              toolUseId: SEND,
              summary: "Second answer.",
              uuid: "00000000-0000-4000-8000-000000001108",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitContinuation(1);
          const beforeExit = sendItems();

          yield* Queue.shutdown(harness.sdkMessages);
          yield* yieldTicks(50);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-exit-resume-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          assert.equal(harness.processQueues.length, 2);
          yield* Queue.offer(
            harness.processQueues[1]!,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001109",
              result: "The audit finished.",
            }),
          );
          yield* harness.awaitTerminal(2);

          const input = JSON.stringify(SEND_INPUT);
          assert.deepEqual(beforeExit, [`dynamic_tool:running:${input}`]);
          assert.deepEqual(sendItems(), [
            `dynamic_tool:running:${input}`,
            `dynamic_tool:completed:${input}`,
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
