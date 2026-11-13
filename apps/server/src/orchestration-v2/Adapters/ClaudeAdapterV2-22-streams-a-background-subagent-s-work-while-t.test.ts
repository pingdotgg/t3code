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
  makeResultFrame,
  makeWakeHarness,
  makeSubagentAssistantFrames,
  makeSubagentToolResultFrame,
  makeSubagentTaskStartedFrame,
  makeSubagentNotificationFrame,
  subagentRouting,
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
  it.effect("streams a background subagent's work while the root turn is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TASK_ID = "task-live-idle";
        const TOOL_USE_ID = "toolu-live-idle";
        const STRADDLING_BASH = "toolu-live-straddling-bash";
        const IDLE_BASH = "toolu-live-idle-bash";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const latestToolItem = (nativeId: string) =>
          harness.events.findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === nativeId,
          );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-live-idle-1"),
            text: "Audit in the background.",
            attachments: [],
          }),
        );
        for (const frame of [
          makeSubagentTaskStartedFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000951",
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000952",
            bashToolUseId: STRADDLING_BASH,
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000953",
            result: "Auditing in the background.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);

        for (const frame of [
          makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000954",
            toolUseId: STRADDLING_BASH,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000955",
            text: "Still auditing.",
            bashToolUseId: IDLE_BASH,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: TASK_ID,
            description: "Reading the last commits",
            uuid: "00000000-0000-4000-8000-000000000956",
            session_id: WAKE_NATIVE_SESSION,
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.until(() => {
          const event = latestToolItem(IDLE_BASH);
          return event?.type === "turn_item.updated" && event.turnItem.status === "running";
        });
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.progress === "Reading the last commits",
          ),
        );
        const routing = subagentRouting(harness.events, [STRADDLING_BASH, IDLE_BASH]);
        assert.deepEqual(routing.assistantTexts(routing.childThreadId), ["Still auditing."]);
        const straddling = latestToolItem(STRADDLING_BASH);
        const straddlingItem =
          straddling?.type === "turn_item.updated" ? straddling.turnItem : undefined;
        assert.equal(straddlingItem?.status, "completed");
        assert.equal(
          straddlingItem?.type === "command_execution" ? straddlingItem.input : undefined,
          "git log -5",
        );
        assert.equal(harness.continuationRequests.length, 0);

        for (const frame of [
          makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000957",
            toolUseId: IDLE_BASH,
          }),
          makeSubagentNotificationFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            summary: "Still auditing.",
            uuid: "00000000-0000-4000-8000-000000000958",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitContinuation(1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000959",
            result: "The auditor finished.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-live-idle-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(2);

        const finalRouting = subagentRouting(harness.events, [STRADDLING_BASH, IDLE_BASH]);
        assert.deepEqual(finalRouting.assistantTexts(finalRouting.childThreadId), [
          "Still auditing.",
        ]);
        for (const nativeId of [STRADDLING_BASH, IDLE_BASH]) {
          assert.deepEqual(
            [...(finalRouting.toolThreadIds.get(nativeId) ?? [])],
            [finalRouting.childThreadId],
          );
          const statuses = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId
              ? [`${event.turnItem.type}:${event.turnItem.status}`]
              : [],
          );
          assert.deepEqual(statuses, ["command_execution:running", "command_execution:completed"]);
        }
        const finalSubagent = harness.events.findLast((event) => event.type === "subagent.updated");
        assert.equal(
          finalSubagent?.type === "subagent.updated" && finalSubagent.subagent.status,
          "completed",
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
  it.effect("keeps a nested subagent's launch in order while the root turn is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const OUTER_TASK_ID = "task-idle-outer";
        const OUTER_TOOL_USE_ID = "toolu-idle-outer";
        const NESTED_TASK_ID = "task-idle-nested";
        const NESTED_TOOL_USE_ID = "toolu-idle-nested";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-idle-nested-1"),
            text: "Audit in the background.",
            attachments: [],
          }),
        );
        for (const frame of [
          makeSubagentTaskStartedFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000971",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000972",
            result: "Auditing in the background.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);

        for (const frame of [
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_idle_nested_launch",
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
            uuid: "00000000-0000-4000-8000-000000000973",
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
            uuid: "00000000-0000-4000-8000-000000000974",
            session_id: WAKE_NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: OUTER_TASK_ID,
            description: "Waiting on the nested check",
            uuid: "00000000-0000-4000-8000-000000000984",
            session_id: WAKE_NATIVE_SESSION,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000988",
            messageId: "msg_idle_outer_working",
            text: "OUTER_WORKING",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.until(() =>
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === "OUTER_WORKING",
          ),
        );
        assert.lengthOf(harness.continuationRequests, 0);
        for (const frame of [
          ...makeSubagentAssistantFrames({
            parentToolUseId: NESTED_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000975",
            text: "NESTED_OK",
          }),
          makeSubagentNotificationFrame({
            taskId: NESTED_TASK_ID,
            toolUseId: NESTED_TOOL_USE_ID,
            summary: "NESTED_OK",
            uuid: "00000000-0000-4000-8000-000000000976",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000977",
            toolUseId: NESTED_TOOL_USE_ID,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000978",
            text: "OUTER_DONE",
          }),
          makeSubagentNotificationFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            summary: "OUTER_DONE",
            uuid: "00000000-0000-4000-8000-000000000979",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitContinuation(1);
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.progress === "Waiting on the nested check",
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000980",
            result: "The audit finished.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-idle-nested-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(2);

        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === NESTED_TOOL_USE_ID,
          ),
        );
        const finalSubagents = new Map(
          harness.events.flatMap((event) =>
            event.type === "subagent.updated"
              ? [[event.subagent.nativeTaskRef?.nativeId, event.subagent] as const]
              : [],
          ),
        );
        const outer = finalSubagents.get(OUTER_TASK_ID);
        const nested = finalSubagents.get(NESTED_TASK_ID);
        assert.equal(outer?.status, "completed");
        assert.equal(nested?.status, "completed");
        assert.equal(nested?.parentNodeId, outer?.id);
        assert.deepEqual(
          subagentRouting(harness.events, []).assistantTexts(outer?.childThreadId ?? undefined),
          ["OUTER_WORKING", "OUTER_DONE"],
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
  it.effect("ends an earlier turn's nested subagent while the root turn is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const OUTER_TASK_ID = "task-earlier-outer";
        const OUTER_TOOL_USE_ID = "toolu-earlier-outer";
        const NESTED_TASK_ID = "task-earlier-nested";
        const NESTED_TOOL_USE_ID = "toolu-earlier-nested";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const userTurn = (attemptId: string, providerTurnOrdinal: number) =>
          harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make(attemptId),
              text: "Keep auditing.",
              attachments: [],
              providerTurnOrdinal,
            }),
          );
        yield* userTurn("attempt-claude-earlier-nested-1", 1);
        for (const frame of [
          makeSubagentTaskStartedFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a01",
          }),
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_earlier_nested_launch",
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
            uuid: "00000000-0000-4000-8000-000000000a02",
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
            uuid: "00000000-0000-4000-8000-000000000a03",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000a04",
            result: "Auditing in the background.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);
        yield* userTurn("attempt-claude-earlier-nested-2", 2);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000a05", result: "Still on it." }),
        );
        yield* harness.awaitTerminal(2);

        for (const frame of [
          makeSubagentNotificationFrame({
            taskId: NESTED_TASK_ID,
            toolUseId: NESTED_TOOL_USE_ID,
            summary: "NESTED_OK",
            uuid: "00000000-0000-4000-8000-000000000a06",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a07",
            toolUseId: NESTED_TOOL_USE_ID,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: OUTER_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a08",
            text: "OUTER_AFTER_NESTED",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "message.updated" && event.message.text === "OUTER_AFTER_NESTED",
          ),
        );

        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === NESTED_TOOL_USE_ID,
          ),
        );
        const nested = harness.events.findLast(
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.nativeTaskRef?.nativeId === NESTED_TASK_ID,
        );
        assert.equal(nested?.type === "subagent.updated" && nested.subagent.status, "completed");
        assert.lengthOf(harness.continuationRequests, 0);
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
