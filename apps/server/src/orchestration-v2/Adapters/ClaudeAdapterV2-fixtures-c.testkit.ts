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
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  DEFAULT_CLAUDE_SETTINGS,
  form,
  makeClaudeTestTurnInput,
  options,
} from "./ClaudeAdapterV2-fixtures-a.testkit.ts";
import {
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeChangeSignal,
  makeResultFrame,
  makeWakeHarness,
  makeWakeHarnessWithOptions,
} from "./ClaudeAdapterV2-fixtures-b.testkit.ts";

export const attachmentBudgetOutcomes = [
  "resume",
  "legacy",
  "compacted",
  "preserved-segment",
  "preserved-messages",
  "failed",
  "stopped",
  "fork-bytes",
  "fork-pages",
] as const;

export const openPlanTurn = Effect.fn("openPlanTurn")(function* (
  runtimeMode: "auto" | "full-access",
  approvalPolicy?: "never",
) {
  const harness = yield* makeWakeHarness;
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "plan",
    cwd: "/workspace",
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
  });
  const input = makeClaudeTestTurnInput({
    threadId: harness.threadId,
    providerThread: harness.providerThread,
    now: yield* DateTime.now,
    attemptId: RunAttemptId.make("attempt-claude-plan-write"),
    text: "Investigate before implementing.",
    attachments: [],
    runtimePolicy,
  });
  yield* harness.runtime.startTurn({
    ...input,
    appThread: { ...input.appThread, runtimeMode, interactionMode: "plan" },
  });
  assert.equal(harness.getOpenedOptions()?.permissionMode, "plan");
  const canUseTool = harness.getOpenedOptions()?.canUseTool;
  assert.isDefined(canUseTool);
  return { ...harness, canUseTool: canUseTool! };
});

export const requestWrite = Effect.fn("requestPlanWrite")(function* (
  turn: Effect.Success<ReturnType<typeof openPlanTurn>>,
  toolName: string,
  toolInput: Record<string, unknown>,
  options?: { toolUseID: string; agentID?: string },
) {
  const decision = yield* Effect.promise(() =>
    turn.canUseTool(toolName, toolInput, {
      signal: new AbortController().signal,
      toolUseID: options?.toolUseID ?? "tool-plan-write",
      requestId: "request-plan-write",
      ...(options?.agentID === undefined ? {} : { agentID: options.agentID }),
    }),
  ).pipe(Effect.forkScoped);
  const first = yield* Effect.raceFirst(
    Queue.take(turn.runtimeRequestReceipts).pipe(
      Effect.map((event) => ({ type: "request", event }) as const),
    ),
    Fiber.join(decision).pipe(Effect.map((result) => ({ type: "decision", result }) as const)),
  );
  return { first, decision };
});

export const testLayer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);

export const approvalOnly: ElicitationRequest = {
  serverName: "deploys",
  message: "Deploy web to production?",
  mode: "form",
  requestedSchema: { type: "object", properties: {} },
  title: "Deploy",
};

export const startElicitationTurn = Effect.fnUntraced(function* (
  options?: Parameters<typeof makeWakeHarnessWithOptions>[0],
) {
  const harness = yield* makeWakeHarnessWithOptions(options);
  yield* harness.runtime.startTurn(
    makeClaudeTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("attempt-claude-elicitation"),
      text: "Deploy web.",
      attachments: [],
    }),
  );
  const onElicitation = harness.getOpenedOptions()?.onElicitation;
  if (onElicitation === undefined) throw new Error("The Claude query has no onElicitation.");
  const runtimeRequests = () =>
    harness.events.flatMap((event) =>
      event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
    );
  let requestNumber = 0;
  const elicit = (request: ElicitationRequest, signal = new AbortController().signal) =>
    Effect.promise(() =>
      onElicitation(request, { signal, requestId: `sdk-${requestNumber++}` }),
    ).pipe(Effect.forkScoped);
  const awaitCard = Effect.fnUntraced(function* (count: number) {
    const event = yield* Queue.take(harness.runtimeRequestReceipts);
    assert.equal(runtimeRequests().length, count);
    return event.runtimeRequest;
  });
  return { harness, elicit, awaitCard, runtimeRequests };
});

export const lastProviderTurn = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
  const event = events.findLast((candidate) => candidate.type === "provider_turn.updated");
  if (event?.type !== "provider_turn.updated") {
    throw new Error("Expected a provider turn update.");
  }
  return event.providerTurn;
};

export const makeRollbackHarness = makeWakeHarnessWithOptions({
  close: (sdkMessages) => Queue.shutdown(sdkMessages),
});

export const usageStreamFrame = (event: unknown, parentToolUseId: string | null = null) =>
  claudeSdkFrame({
    type: "stream_event",
    event,
    parent_tool_use_id: parentToolUseId,
    session_id: WAKE_NATIVE_SESSION,
    uuid: "usage-stream-frame",
  });

export const usageSnapshotFrame = (id: string, uuid: string, usage: unknown) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Working." }],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
    parent_tool_use_id: null,
    uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const zeroUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export const reportedContextTokens = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) =>
    event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
      ? [event.providerTurn.tokenUsage.usedTokens]
      : [],
  );

export type TaskToolCall =
  | { name: "TaskCreate"; input: TaskCreateInput; output: TaskCreateOutput }
  | { name: "TaskUpdate"; input: TaskUpdateInput; output: TaskUpdateOutput }
  | { name: "TaskList"; input: Record<string, never>; output: TaskListOutput };

export function taskToolFrames(
  tool: TaskToolCall,
  nextUuid: () => string,
  options?: {
    parentToolUseId?: string;
    isError?: boolean;
    extraToolResult?: boolean;
    nonExecutionKind?: string;
  },
): ReadonlyArray<SDKMessage> {
  const uuid = nextUuid();
  const toolUseId = `tool-${uuid}`;
  const parentToolUseId = options?.parentToolUseId ?? null;
  return [
    claudeSdkFrame({
      type: "assistant",
      message: {
        id: `msg_${uuid}`,
        model: "claude-sonnet-4-6",
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: tool.name, input: tool.input }],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: parentToolUseId,
      uuid,
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
            content:
              parentToolUseId !== null && tool.name === "TaskCreate"
                ? `Task #${tool.output.task.id} created successfully: ${tool.output.task.subject}`
                : parentToolUseId !== null && tool.name === "TaskUpdate"
                  ? tool.output.success
                    ? `Updated task #${tool.output.taskId} ${tool.output.updatedFields.join(", ")}`
                    : tool.output.error
                  : "Task tool finished.",
            ...(options?.isError === undefined ? {} : { is_error: options.isError }),
          },
          ...(options?.extraToolResult
            ? [{ type: "tool_result", tool_use_id: "unrelated-tool", content: "ok" }]
            : []),
        ],
      },
      // Like real Claude, subagent results carry only the text, no `tool_use_result`.
      ...(parentToolUseId === null ? { tool_use_result: tool.output } : {}),
      ...(options?.nonExecutionKind === undefined
        ? {}
        : {
            tool_result_meta: [{ id: toolUseId, non_execution_kind: options.nonExecutionKind }],
          }),
      parent_tool_use_id: parentToolUseId,
      uuid: nextUuid(),
      session_id: WAKE_NATIVE_SESSION,
    }),
  ];
}

export const makeTaskToolHarnessWithOptions = (environment: NodeJS.ProcessEnv = {}) =>
  Effect.gen(function* () {
    const configDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "t3-claude-tasks-",
    });
    const path = yield* Path.Path;
    const harness = yield* makeWakeHarnessWithOptions({
      environment: {
        CLAUDE_CONFIG_DIR: path.relative(CLAUDE_TEST_RUNTIME_POLICY.cwd ?? ".", configDir),
        ...environment,
      },
    });
    let sequence = 600;
    let turn = 0;
    const nextUuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    const startTurn = Effect.fnUntraced(function* () {
      turn++;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`attempt-claude-task-tools-${turn}`),
          providerTurnOrdinal: turn,
          text: "Update the task list.",
          attachments: [],
        }),
      );
    });
    const call = Effect.fnUntraced(function* (
      tool: TaskToolCall,
      options?: Parameters<typeof taskToolFrames>[2],
    ) {
      for (const frame of taskToolFrames(tool, nextUuid, options)) {
        yield* harness.offerAndWait(frame);
      }
    });
    const finishTurn = Effect.fnUntraced(function* () {
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: nextUuid(), result: "Task list updated." }),
      );
      return yield* Queue.take(harness.terminalReceipts);
    });
    const plans = () =>
      harness.events.flatMap((event) =>
        event.type === "plan.updated" && event.plan.kind === "todo_list" ? [event.plan] : [],
      );
    // Registers a running subagent so frames carrying its tool_use_id as
    // parent_tool_use_id are processed instead of held for an unknown owner.
    const launchSubagent = (toolUseId: string) =>
      harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: `task-${toolUseId}`,
          tool_use_id: toolUseId,
          description: "Work on tasks",
          task_type: "local_agent",
          uuid: nextUuid(),
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
    return { configDir, startTurn, call, launchSubagent, finishTurn, plans };
  });

export const makeTaskToolHarness = makeTaskToolHarnessWithOptions();

export const createTask = (id: string, subject: string): TaskToolCall => ({
  name: "TaskCreate",
  input: { subject: `Requested ${subject}`, description: `Work on ${subject}.` },
  output: { task: { id, subject } },
});

export const updateTask = (input: TaskUpdateInput, success = true): TaskToolCall => ({
  name: "TaskUpdate",
  input,
  output: { success, taskId: input.taskId, updatedFields: ["status"] },
});

export const providerThreadRosterEvents = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
) =>
  events.filter(
    (
      event,
    ): event is Extract<
      ProviderAdapter.ProviderAdapterV2Event,
      { type: "provider_thread.updated" }
    > => event.type === "provider_thread.updated",
  );

export const makeSubagentAssistantFrames = (input: {
  readonly parentToolUseId: string;
  readonly uuid: string;
  readonly messageId?: string;
  readonly text?: string;
  readonly bashToolUseId?: string;
}): ReadonlyArray<SDKMessage> =>
  [
    ...(input.text === undefined ? [] : [{ type: "text", text: input.text }]),
    ...(input.bashToolUseId === undefined
      ? []
      : [
          {
            type: "tool_use",
            id: input.bashToolUseId,
            name: "Bash",
            input: { command: "git log -5" },
          },
        ]),
  ].map((block, index) =>
    claudeSdkFrame({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id: input.messageId ?? `msg_${input.uuid}`,
        type: "message",
        role: "assistant",
        content: [block],
      },
      parent_tool_use_id: input.parentToolUseId,
      uuid: index === 0 ? input.uuid : `${input.uuid}:${index}`,
      session_id: WAKE_NATIVE_SESSION,
    }),
  );

export const makeSubagentToolResultFrame = (input: {
  readonly parentToolUseId: string;
  readonly uuid: string;
  readonly toolUseId: string;
}) =>
  claudeSdkFrame({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: input.toolUseId, content: "ok" }],
    },
    parent_tool_use_id: input.parentToolUseId,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const makeSubagentTaskStartedFrame = (input: {
  readonly taskId: string;
  readonly toolUseId: string;
  readonly uuid: string;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_started",
    task_id: input.taskId,
    tool_use_id: input.toolUseId,
    description: "Audit recent commits",
    subagent_type: "general-purpose",
    is_backgrounded: true,
    task_type: "local_agent",
    prompt: "Audit the last five commits.",
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const makeSubagentNotificationFrame = (input: {
  readonly taskId: string;
  readonly toolUseId: string;
  readonly summary: string;
  readonly uuid: string;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_notification",
    task_id: input.taskId,
    tool_use_id: input.toolUseId,
    status: "completed",
    output_file: `/tmp/${input.taskId}.output`,
    summary: input.summary,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const subagentRouting = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  nativeToolIds: ReadonlyArray<string>,
) => {
  const childThreadId =
    events.find((event) => event.type === "subagent.updated")?.subagent.childThreadId ??
    undefined;
  const toolThreadIds = new Map<string, Set<string>>();
  for (const event of events) {
    const nativeId =
      event.type === "turn_item.updated" ? event.turnItem.nativeItemRef?.nativeId : undefined;
    if (event.type === "turn_item.updated" && nativeId && nativeToolIds.includes(nativeId)) {
      toolThreadIds.set(
        nativeId,
        (toolThreadIds.get(nativeId) ?? new Set()).add(event.turnItem.threadId),
      );
    }
  }
  const assistantTexts = (threadId: string | undefined) =>
    events.flatMap((event) =>
      event.type === "message.updated" &&
      event.message.role === "assistant" &&
      event.message.threadId === threadId
        ? [event.message.text]
        : [],
    );
  return { childThreadId, toolThreadIds, assistantTexts };
};

export const stopRacedByReplacementTurn = (label: string) =>
  Effect.gen(function* () {
    const changes = yield* makeChangeSignal;
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: `t3-claude-v2-${label}-`,
    });
    const processQueues: Array<Queue.Queue<SDKMessage>> = [];
    // The first two processes exit only when the test ends their streams.
    const closeRequested = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      continuationRequests: { offer: () => Effect.void },
      queryRunner: {
        allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
        open: () =>
          Effect.gen(function* () {
            const sdkMessages = yield* Queue.unbounded<SDKMessage>();
            const closeSignal = closeRequested[processQueues.length];
            processQueues.push(sdkMessages);
            return {
              messages: Stream.fromQueue(sdkMessages),
              offer: () => Effect.void,
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              stopTask: () => Effect.void,
              interrupt: Effect.void,
              close:
                closeSignal === undefined
                  ? Queue.shutdown(sdkMessages)
                  : Deferred.succeed(closeSignal, undefined).pipe(Effect.asVoid),
            };
          }),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make(`thread-claude-${label}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-claude-${label}`),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(Effect.andThen(changes.notify)),
      ),
      Effect.forkScoped,
    );
    const terminals = () => events.filter((event) => event.type === "turn.terminal");
    const subagentStatus = (taskId: string) => {
      const latest = events.findLast(
        (event) =>
          event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === taskId,
      );
      return latest?.type === "subagent.updated" ? latest.subagent.status : undefined;
    };
    const now = yield* DateTime.now;

    yield* runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId,
        providerThread,
        now,
        attemptId: RunAttemptId.make(`attempt-claude-${label}-a`),
        text: "Audit the last commits in the background.",
        attachments: [],
      }),
    );
    yield* Queue.offer(
      processQueues[0]!,
      makeSubagentTaskStartedFrame({
        taskId: "raced-agent",
        toolUseId: "toolu-raced-agent",
        uuid: "00000000-0000-4000-8000-000000002801",
      }),
    );
    yield* Queue.offer(
      processQueues[0]!,
      makeResultFrame({
        uuid: "00000000-0000-4000-8000-000000002802",
        result: "Launched the audit.",
      }),
    );
    yield* changes.until(
      () => terminals().length === 1 && subagentStatus("raced-agent") === "running",
    );

    const stop = yield* runtime
      .interruptTurn({
        providerThread,
        providerTurnId: terminals()[0]!.providerTurnId,
        requestRuntimeRestart: true,
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(closeRequested[0]!);
    yield* runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId,
        providerThread: { ...providerThread, status: "active" },
        now,
        attemptId: RunAttemptId.make(`attempt-claude-${label}-b`),
        text: "Resume after the limit reset.",
        attachments: [],
        providerTurnOrdinal: 2,
      }),
    );
    assert.lengthOf(processQueues, 2);
    yield* Queue.offer(
      processQueues[1]!,
      makeSubagentTaskStartedFrame({
        taskId: "own-agent",
        toolUseId: "toolu-own-agent",
        uuid: "00000000-0000-4000-8000-000000002804",
      }),
    );
    yield* changes.until(() => subagentStatus("own-agent") === "running");
    const exitProcess = <E>(index: number, stopping: Fiber.Fiber<void, E>) =>
      Queue.shutdown(processQueues[index]!).pipe(Effect.andThen(Fiber.join(stopping)));
    return {
      runtime,
      threadId,
      providerThread,
      processQueues,
      closeRequested,
      changes,
      terminals,
      subagentStatus,
      exitFirstProcess: exitProcess(0, stop),
      exitProcess,
      now,
    };
  });

// regression: #28331 a subagent whose process is gone must not stay running forever

