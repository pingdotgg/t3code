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
  wakeTurnInit,
  makeWakeHarness,
  makeSubagentTaskStartedFrame,
  makeSubagentNotificationFrame,
  syntheticFrame,
  stopHookFeedback,
  goalStatuses,
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
  describe("native goals", () => {
    const syntheticFrame = (uuid: string, text: string) =>
      claudeSdkFrame({
        type: "assistant",
        message: {
          model: "<synthetic>",
          id: uuid,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        uuid,
        session_id: WAKE_NATIVE_SESSION,
      });
    const stopHookFeedback = (uuid: string, condition: string, reason: string) =>
      claudeSdkFrame({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: `Stop hook feedback:\n[${condition}]: ${reason}` }],
        },
        parent_tool_use_id: null,
        isSynthetic: true,
        uuid,
        session_id: WAKE_NATIVE_SESSION,
      });
    const goalStatuses = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
      events.flatMap((event) =>
        event.type === "provider_thread.updated" && event.providerThread.goal != null
          ? [event.providerThread.goal]
          : [],
      );

    it.effect("tracks a /goal through unmet checks until Claude stops on its own", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const condition = "all tests pass";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-attempt"),
            text: `/goal ${condition}`,
            attachments: [],
          }),
        );
        for (const frame of [
          syntheticFrame("goal-set", `Goal set: ${condition}`),
          makeAssistantTextFrame({ uuid: "goal-work-1", text: "Fixing the first test." }),
          stopHookFeedback("goal-check-1", condition, "One test still fails."),
          makeAssistantTextFrame({ uuid: "goal-work-2", text: "All tests pass now." }),
          makeResultFrame({ uuid: "goal-result", result: "All tests pass now." }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "completed");
        assert.deepEqual(goalStatuses(harness.events), [
          { objective: condition, status: "active", checks: 0 },
          {
            objective: condition,
            status: "active",
            checks: 1,
            lastCheck: "One test still fails.",
          },
          { objective: condition, status: "complete", checks: 1 },
        ]);
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

    it.effect(
      "defers goal completion until an ambient subagent finishes and Claude checks again",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const condition = "the review finds no bugs";
          const taskId = "task-goal-review";
          const toolUseId = "toolu-goal-review";
          const now = yield* DateTime.now;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("goal-background-attempt"),
              text: `/goal ${condition}`,
              attachments: [],
            }),
          );
          for (const frame of [
            syntheticFrame("goal-background-set", `Goal set: ${condition}`),
            claudeSdkFrame({
              ...makeSubagentTaskStartedFrame({ taskId, toolUseId, uuid: "goal-review-start" }),
              ambient: true,
              skip_transcript: true,
            }),
            makeAssistantTextFrame({
              uuid: "goal-background-wait",
              text: "Waiting for the review.",
            }),
            makeResultFrame({ uuid: "goal-background-result", result: "Waiting for the review." }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
          assert.deepEqual(goalStatuses(harness.events).at(-1), {
            objective: condition,
            status: "active",
            checks: 0,
          });

          yield* harness.offerAndWait(
            makeSubagentNotificationFrame({
              taskId,
              toolUseId,
              summary: "No bugs found.",
              uuid: "goal-review-done",
            }),
          );
          yield* harness.offerAndWait(wakeTurnInit);
          yield* Queue.take(harness.continuationReceipts);
          assert.equal(goalStatuses(harness.events).at(-1)?.status, "active");
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("goal-background-wake"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* harness.offerAndWait(
            makeAssistantTextFrame({ uuid: "goal-background-wake-work", text: "No bugs found." }),
          );
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "goal-background-wake-result",
              result: "No bugs found.",
              origin: { kind: "task-notification" },
            }),
          );
          assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
          assert.deepEqual(goalStatuses(harness.events).at(-1), {
            objective: condition,
            status: "complete",
            checks: 0,
          });
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

    it.effect.each([
      { taskType: "mcp_task", status: "complete" },
      { taskType: undefined, status: "active" },
    ] as const)("leaves the goal $status with a running $taskType task", ({ taskType, status }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const condition = "the docs build";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-task-type-attempt"),
            text: `/goal ${condition}`,
            attachments: [],
          }),
        );
        for (const frame of [
          syntheticFrame("goal-task-type-set", `Goal set: ${condition}`),
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "task-goal-docs",
            description: "Watch the docs",
            ...(taskType === undefined ? {} : { task_type: taskType }),
            uuid: "goal-task-type-start",
            session_id: WAKE_NATIVE_SESSION,
          }),
          makeAssistantTextFrame({ uuid: "goal-task-type-work", text: "The docs build." }),
          makeResultFrame({ uuid: "goal-task-type-result", result: "The docs build." }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
        assert.equal(goalStatuses(harness.events).at(-1)?.status, status);
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

    it.effect("keeps a goal active after a command turn with no model output", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const condition = "the build is green";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: {
              ...harness.providerThread,
              goal: { objective: condition, status: "active", checks: 2 },
            },
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-show-attempt"),
            text: "/goal",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          syntheticFrame("goal-show", `Goal active: ${condition} (2 turns)`),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "goal-show-result", result: "", numTurns: 0 }),
        );
        yield* Queue.take(harness.terminalReceipts);
        assert.deepEqual(goalStatuses(harness.events).at(-1), {
          objective: condition,
          status: "active",
          checks: 2,
        });
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

    it.effect("keeps the CLI's goal confirmation out of the conversation", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const condition = "all tests pass";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: {
              ...harness.providerThread,
              goal: { objective: condition, status: "active", checks: 1 },
            },
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-clear-attempt"),
            text: "/goal clear",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          syntheticFrame("goal-clear", `Goal cleared: ${condition}`),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "goal-clear-result",
            result: `Goal cleared: ${condition}\n`,
            numTurns: 0,
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "provider_thread.updated" && event.providerThread.goal === null,
          ),
        );
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.role === "assistant",
          ),
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
});
