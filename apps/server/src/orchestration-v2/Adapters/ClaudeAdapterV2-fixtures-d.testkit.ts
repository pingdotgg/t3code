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
  options,
} from "./ClaudeAdapterV2-fixtures-a.testkit.ts";
import {
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeResultFrame,
  makeWakeHarnessWithOptions,
} from "./ClaudeAdapterV2-fixtures-b.testkit.ts";
import {
  makeSubagentNotificationFrame,
  makeSubagentTaskStartedFrame,
} from "./ClaudeAdapterV2-fixtures-c.testkit.ts";
export const makeStopFixture = (options?: Parameters<typeof makeWakeHarnessWithOptions>[0]) =>
  Effect.gen(function* () {
    const requests = yield* Queue.unbounded<void>();
    const harness = yield* makeWakeHarnessWithOptions({
      ...options,
      stopTask: (id) =>
        Queue.offer(requests, undefined).pipe(
          Effect.andThen(options?.stopTask?.(id) ?? Effect.void),
        ),
    });
    let sequence = 4500;
    const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    const startTurn = (continuation = false) =>
      harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: DateTime.makeUnsafe(0),
          attemptId: RunAttemptId.make(`attempt-stop-${continuation ? 2 : 1}`),
          providerTurnOrdinal: continuation ? 2 : 1,
          text: "Run an audit.",
          attachments: [],
          ...(continuation
            ? { messageCreatedBy: "agent" as const, messageCreationSource: "provider" as const }
            : {}),
        }),
      );
    const start = (toolUseId = "toolu-stop-agent") =>
      harness.offerAndWait(
        makeSubagentTaskStartedFrame({
          taskId: "stop-agent",
          toolUseId,
          uuid: uuid(),
        }),
      );
    const notify = (
      status: "completed" | "failed" | "stopped",
      summary = "Native outcome.",
      toolUseId = "toolu-stop-agent",
    ) =>
      harness.offerAndWait(
        claudeSdkFrame({
          ...makeSubagentNotificationFrame({
            taskId: "stop-agent",
            toolUseId,
            summary,
            uuid: uuid(),
          }),
          status,
        }),
      );
    const stop = (requestedAt?: DateTime.Utc) =>
      harness.runtime.stopSubagent!({
        providerThread: harness.providerThread,
        nativeTaskId: "stop-agent",
        ...(requestedAt === undefined ? {} : { requestedAt }),
      });
    const finishParent = () =>
      harness
        .offerAndWait(makeResultFrame({ uuid: uuid(), result: "Launched." }))
        .pipe(Effect.andThen(Queue.take(harness.terminalReceipts)));
    yield* startTurn();
    yield* start();
    yield* Queue.take(harness.subagentReceipts);
    return {
      ...harness,
      start,
      notify,
      stop,
      finishParent,
      replay: () => startTurn(true),
      uuid,
      requests,
    };
  });

export const WORKFLOW_TASK_ID = "task-workflow-run";

export const WORKFLOW_TOOL_USE_ID = "toolu-workflow-run";

export const makeWorkflowHarnessWithOptions = (
  options?: Parameters<typeof makeWakeHarnessWithOptions>[0],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-wf-" });
    const transcriptDir = NodePath.join(configDir, "projects", "workflow");
    yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
    yield* fileSystem.writeFileString(
      NodePath.join(transcriptDir, "agent-a1.jsonl"),
      `{"type":"assistant","effort":"xhigh","uuid":"wf-line-1-${options?.nativeSessionId ?? "default"}","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_a1","usage":{"speed":"standard"},"content":[{"type":"text","text":"A1 from the transcript"}]}}\n`,
    );
    const harness = yield* makeWakeHarnessWithOptions({
      ...options,
      environment: { ...options?.environment, CLAUDE_CONFIG_DIR: configDir },
    });
    return { ...harness, transcriptDir };
  });

export const makeWorkflowHarness = makeWorkflowHarnessWithOptions();

export const workflowToolUse = claudeSdkFrame({
  type: "assistant",
  message: {
    model: "claude-sonnet-4-6",
    content: [
      {
        type: "tool_use",
        id: WORKFLOW_TOOL_USE_ID,
        name: "Workflow",
        input: { script: "alpha.js" },
      },
    ],
  },
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-000000001001",
  session_id: WAKE_NATIVE_SESSION,
});

export const workflowTaskStarted = claudeSdkFrame({
  type: "system",
  subtype: "task_started",
  task_id: WORKFLOW_TASK_ID,
  tool_use_id: WORKFLOW_TOOL_USE_ID,
  description: "Run the alpha workflow",
  task_type: "local_workflow",
  workflow_name: "probe-wf",
  uuid: "00000000-0000-4000-8000-000000001002",
  session_id: WAKE_NATIVE_SESSION,
});

export const workflowLaunchAck = (transcriptDir: string) =>
  claudeSdkFrame({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: WORKFLOW_TOOL_USE_ID,
          content: [{ type: "text", text: "Workflow launched." }],
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000001003",
    session_id: WAKE_NATIVE_SESSION,
    tool_use_result: {
      taskType: "local_workflow",
      runId: "wf_probe",
      transcriptDir,
    },
  });

export const workflowSnapshot = (input: {
  readonly uuid: string;
  readonly state: "queued" | "start" | "done";
  readonly secondState?: "queued" | "start" | "done";
  readonly startedAt?: number;
  readonly lastProgressAt?: number;
  readonly durationMs?: number;
  readonly label?: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly attempt?: number;
  readonly omitResult?: boolean;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_progress",
    task_id: WORKFLOW_TASK_ID,
    tool_use_id: WORKFLOW_TOOL_USE_ID,
    description: "Alpha: alpha:one",
    workflow_progress: [
      { type: "workflow_phase", index: 1, title: "Alpha" },
      {
        type: "workflow_agent",
        index: 1,
        label: input.label ?? "alpha:one",
        agentId: "a1",
        state: input.state,
        phaseIndex: 1,
        phaseTitle: "Alpha",
        model: input.model ?? "claude-opus-5[1m]",
        promptPreview: input.prompt ?? "Reply with exactly: A1",
        ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
        ...(input.lastProgressAt === undefined ? {} : { lastProgressAt: input.lastProgressAt }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
        ...(input.state === "done" && input.omitResult !== true
          ? { resultPreview: "A1 excerpt" }
          : {}),
      },
      {
        type: "workflow_agent",
        index: 2,
        label: "alpha:two",
        agentId: "a2",
        state: input.secondState ?? input.state,
        phaseIndex: 1,
        phaseTitle: "Alpha",
        promptPreview: "Reply with exactly: A2",
        ...(input.state === "done" ? { resultPreview: "A2 excerpt" } : {}),
      },
    ],
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const workflowNotification = (input: {
  readonly uuid: string;
  readonly status: "completed" | "failed" | "stopped";
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_notification",
    task_id: WORKFLOW_TASK_ID,
    tool_use_id: WORKFLOW_TOOL_USE_ID,
    status: input.status,
    summary: "Workflow finished.",
    output_file: "/tmp/workflow.output",
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const workflowCoordinatorEvents = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
) =>
  events.filter(
    (
      event,
    ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
      event.type === "subagent.updated" &&
      event.subagent.nativeTaskRef?.nativeId === WORKFLOW_TASK_ID,
  );

export const workflowMemberEvents = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  index: number,
) =>
  events.filter(
    (
      event,
    ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
      event.type === "subagent.updated" &&
      event.subagent.nativeTaskRef?.nativeId?.endsWith(`:agent:${index}`) === true,
  );

export const threadMessages = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  threadId: ThreadId | null | undefined,
) =>
  events.filter(
    (
      event,
    ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "message.updated" }> =>
      event.type === "message.updated" && event.message.threadId === threadId,
  );

export const launchWorkflow = Effect.fnUntraced(function* (input: {
  readonly harness: Effect.Success<typeof makeWorkflowHarness>;
  readonly snapshotUuid: string;
  readonly state?: "queued" | "start";
}) {
  yield* input.harness.offerAndWait(workflowToolUse);
  yield* input.harness.offerAndWait(workflowTaskStarted);
  yield* input.harness.offerAndWait(workflowLaunchAck(input.harness.transcriptDir));
  yield* input.harness.offerAndWait(
    workflowSnapshot({ uuid: input.snapshotUuid, state: input.state ?? "start" }),
  );
  yield* input.harness.until(() => workflowMemberEvents(input.harness.events, 2).length === 1);
});

export const transcriptLine = (entry: Record<string, unknown>) =>
  `${JSON.stringify({ isSidechain: true, agentId: "a1", timestamp: "2026-10-17T05:08:07.524Z", ...entry })}\n`;

export const memberAssistantLine = (
  uuid: string,
  messageId: string,
  content: unknown,
  stopReason?: "tool_use" | "end_turn",
) =>
  transcriptLine({
    type: "assistant",
    uuid,
    message: {
      model: "claude-opus-5-5",
      id: messageId,
      type: "message",
      role: "assistant",
      content,
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    },
  });

export const memberToolResultLine = (uuid: string, toolUseId: string, output: string) =>
  transcriptLine({
    type: "user",
    uuid,
    message: {
      role: "user",
      content: [{ tool_use_id: toolUseId, type: "tool_result", content: output }],
    },
  });

export const memberTranscript = [
  transcriptLine({
    type: "user",
    uuid: "line-prompt",
    message: { role: "user", content: "Reply with exactly: A1" },
  }),
  transcriptLine({
    type: "attachment",
    uuid: "line-attachment",
    attachment: { type: "skill_listing", content: "- adhd" },
  }),
  transcriptLine({
    type: "user",
    uuid: "line-meta",
    isMeta: true,
    message: { role: "user", content: "<system-reminder>context</system-reminder>" },
  }),
  memberAssistantLine("line-thinking", "msg_a1", [
    { type: "thinking", thinking: "List the files first.", signature: "sig" },
  ]),
  memberAssistantLine("line-bash", "msg_a1", [
    { type: "tool_use", id: "toolu_a1_ls", name: "Bash", input: { command: "ls" } },
  ]),
  memberToolResultLine("line-ls-result", "toolu_a1_ls", "README.md"),
  memberAssistantLine("line-reply", "msg_a1_reply", [
    { type: "text", text: "A1 found README.md" },
  ]),
].join("");

export const memberThreadItems = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  threadId: ThreadId | null | undefined,
) =>
  events.flatMap((event) =>
    event.type === "turn_item.updated" && event.turnItem.threadId === threadId
      ? [event.turnItem]
      : [],
  );

export const latestMemberThreadItems = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  threadId: ThreadId | null | undefined,
) =>
  [
    ...new Map(memberThreadItems(events, threadId).map((item) => [item.id, item])).values(),
  ].toSorted((left, right) => left.ordinal - right.ordinal);

export const describeItem = (item: ReturnType<typeof memberThreadItems>[number]) =>
  item.type === "reasoning"
    ? `reasoning: ${item.text}`
    : item.type === "command_execution"
      ? `command ${item.status}: ${item.output ?? ""}`
      : item.type === "assistant_message" || item.type === "user_message"
        ? `${item.type}`
        : `${item.type} ${item.status}`;

export const syntheticFrame = (uuid: string, text: string) =>
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

export const stopHookFeedback = (uuid: string, condition: string, reason: string) =>
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

export const goalStatuses = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) =>
    event.type === "provider_thread.updated" && event.providerThread.goal != null
      ? [event.providerThread.goal]
      : [],
  );

