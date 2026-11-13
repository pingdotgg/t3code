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
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeResultFrame,
  wakeTurnInit,
  makeWakeHarness,
  taskToolFrames,
  makeTaskToolHarnessWithOptions,
  makeTaskToolHarness,
  createTask,
  updateTask,
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
  it.effect("preserves typed Claude plans and todos through generic tool completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const assistantTools = (
          uuid: string,
          tools: ReadonlyArray<Record<string, unknown>>,
          parentToolUseId: string | null = null,
        ) =>
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: `msg_${uuid}`,
              type: "message",
              role: "assistant",
              content: tools.map((tool) => ({ type: "tool_use", ...tool })),
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
          });
        const toolResults = (uuid: string, toolUseIds: ReadonlyArray<string>) =>
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: toolUseIds.map((toolUseId) => ({
                type: "tool_result",
                tool_use_id: toolUseId,
                content: "ok",
              })),
            },
            parent_tool_use_id: null,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-plan-lifecycle-1"),
            text: "Plan the work.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools("00000000-0000-4000-8000-000000000501", [
            {
              id: "tool-todo-1",
              name: "TodoWrite",
              input: { todos: [{ content: "Inspect", status: "in_progress" }] },
            },
          ]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools("00000000-0000-4000-8000-000000000501", [
            {
              id: "tool-todo-1",
              name: "TodoWrite",
              input: { todos: [{ content: "Inspect", status: "in_progress" }] },
            },
          ]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          toolResults("00000000-0000-4000-8000-000000000502", ["tool-todo-1"]),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({ ...wakeTurnInit, permissionMode: "bypassPermissions" }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: null,
            permissionMode: "plan",
            uuid: "00000000-0000-4000-8000-000000000508",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...wakeTurnInit,
            uuid: "00000000-0000-4000-8000-000000000509",
            permissionMode: "plan",
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000503",
            result: "Todo recorded.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-plan-lifecycle-2"),
            providerTurnOrdinal: 2,
            text: "Finish the plan.",
            attachments: [],
          }),
        );
        const canUseTool = harness.getOpenedOptions()?.canUseTool;
        assert.isFunction(canUseTool);
        const planMarkdown = "# Ready to implement\n\n1. Ship it.";
        yield* Effect.promise(() =>
          canUseTool!(
            "ExitPlanMode",
            { plan: planMarkdown },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-exit-plan-1",
              requestId: "request-exit-plan-1",
            },
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools("00000000-0000-4000-8000-000000000504", [
            {
              id: "tool-todo-2",
              name: "TodoWrite",
              input: { todos: [{ content: "Inspect", status: "completed" }] },
            },
            { id: "tool-exit-plan-1", name: "ExitPlanMode", input: { plan: planMarkdown } },
          ]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools(
            "00000000-0000-4000-8000-000000000507",
            [
              {
                id: "tool-subagent-todo",
                name: "TodoWrite",
                input: { todos: [{ content: "Child-only work", status: "in_progress" }] },
              },
            ],
            "tool-parent-agent",
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          toolResults("00000000-0000-4000-8000-000000000505", ["tool-todo-2", "tool-exit-plan-1"]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          assistantTools("00000000-0000-4000-8000-000000000509", [
            {
              id: "tool-todo-3",
              name: "TodoWrite",
              input: { todos: [{ content: "Implement", status: "pending" }] },
            },
          ]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          toolResults("00000000-0000-4000-8000-000000000510", ["tool-todo-3"]),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000506",
            result: "Plan captured.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);

        const items = new Map(
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" ? [[String(event.turnItem.id), event.turnItem]] : [],
          ),
        );
        const plans = new Map(
          harness.events.flatMap((event) =>
            event.type === "plan.updated" ? [[String(event.plan.id), event.plan]] : [],
          ),
        );
        const todoItems = [...items.values()].filter((item) => item.type === "todo_list");
        const proposedItems = [...items.values()].filter((item) => item.type === "proposed_plan");
        assert.lengthOf(todoItems, 3);
        assert.equal(todoItems[1]?.status, "completed");
        assert.deepEqual(todoItems[1]?.steps, [
          { id: "todo-0", text: "Inspect", status: "completed" },
        ]);
        assert.deepEqual(todoItems[2]?.steps, [
          { id: "todo-0", text: "Implement", status: "pending" },
        ]);
        assert.equal(todoItems[1]?.runId, todoItems[2]?.runId);
        assert.lengthOf(proposedItems, 1);
        assert.equal(
          proposedItems[0]?.type === "proposed_plan" && proposedItems[0].markdown,
          planMarkdown,
        );
        assert.isTrue(
          [...items.values()].some(
            (item) =>
              item.type === "dynamic_tool" && item.nativeItemRef?.nativeId === "tool-todo-2",
          ),
        );
        assert.isTrue(
          [...items.values()].some(
            (item) =>
              item.type === "dynamic_tool" && item.nativeItemRef?.nativeId === "tool-exit-plan-1",
          ),
        );
        const proposedPlan = [...plans.values()].find((plan) => plan.kind === "proposed_plan");
        assert.equal(proposedPlan?.status, "active");
        assert.deepEqual(harness.permissionModeChanges, ["bypassPermissions"]);
        assert.deepEqual(
          [...plans.values()]
            .filter((plan) => plan.kind === "todo_list")
            .map((plan) => plan.status),
          ["superseded", "superseded", "active"],
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
  it.effect("persists a todo_list from inline Claude task-tool frames", () =>
    Effect.gen(function* () {
      let sequence = 700;
      const nextUuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      const prompt = "Track a synthetic task.";
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
        provider: "claudeAgent",
        protocol: "claude-agent-sdk.query",
        version: "1",
        scenario: "claude_task_tools_inline",
        metadata: { nativeSessionId: WAKE_NATIVE_SESSION },
        entries: [
          {
            type: "expect_outbound",
            frame: {
              type: "query.open",
              options: {
                model: "claude-sonnet-4-6",
                tools: { type: "preset", preset: "claude_code" },
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                settings: { showThinkingSummaries: true },
                sessionId: WAKE_NATIVE_SESSION,
              },
            },
          },
          {
            type: "expect_outbound",
            frame: {
              type: "prompt.offer",
              message: {
                type: "user",
                message: { role: "user", content: prompt },
                parent_tool_use_id: null,
              },
            },
          },
          ...[
            ...taskToolFrames(createTask("1", "Inspect"), nextUuid),
            ...taskToolFrames(updateTask({ taskId: "1", status: "in_progress" }), nextUuid),
            makeResultFrame({ uuid: nextUuid(), result: "Task recorded." }),
          ].map((frame) => ({ type: "emit_inbound" as const, frame })),
        ],
      } satisfies ProviderReplayTranscript);
      const materialized = yield* materializeFixtureInput({
        scenario: transcript.scenario,
        fixtureInput: { steps: [{ type: "message", text: prompt }] },
        driver: ProviderDriverKind.make("claudeAgent"),
        modelSelection: CLAUDE_MODEL_SELECTION,
      }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
      const scenario = { name: transcript.scenario, transcript, ...materialized };
      yield* Effect.gen(function* () {
        const result = yield* runOrchestratorV2Scenario(scenario);
        assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
        const projection = projectionFor(result, transcript.scenario);
        assertSemanticProjectionIntegrity(projection);
        const plans = projection.plans.filter((plan) => plan.kind === "todo_list");
        assert.lengthOf(plans, 1);
        assert.deepEqual(
          plans[0]?.steps.map(({ id, text, status }) => ({ id, text, status })),
          [{ id: "task-1", text: "Inspect", status: "running" }],
        );
        assert.lengthOf(
          projection.turnItems.filter((item) => item.type === "todo_list"),
          1,
        );
      }).pipe(
        Effect.provide(layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness)),
        provideDeterministicTestRuntime,
        Effect.scoped,
      );
    }),
  );
  it.effect(
    "projects TaskCreate and TaskUpdate into one plan per turn and supersedes it later",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeTaskToolHarness;
        yield* harness.startTurn();
        yield* harness.call(createTask("1", "Inspect"));
        yield* harness.call(createTask("2", "Implement"));
        yield* harness.call(updateTask({ taskId: "1", status: "in_progress" }));
        yield* harness.finishTurn();

        const firstTurnPlans = harness.plans();
        assert.lengthOf(firstTurnPlans, 3);
        assert.equal(new Set(firstTurnPlans.map((plan) => plan.id)).size, 1);
        assert.deepEqual(firstTurnPlans.at(-1)?.steps, [
          { id: "task-1", text: "Inspect", status: "running" },
          { id: "task-2", text: "Implement", status: "pending" },
        ]);
        const firstPlan = firstTurnPlans.at(-1)!;

        yield* harness.startTurn();
        yield* harness.call(updateTask({ taskId: "1", status: "completed", subject: "Inspected" }));
        yield* harness.finishTurn();

        const laterPlans = harness.plans().slice(firstTurnPlans.length);
        assert.lengthOf(laterPlans, 2);
        assert.equal(laterPlans[0]?.id, firstPlan.id);
        assert.equal(laterPlans[0]?.status, "superseded");
        const newPlan = laterPlans[1]!;
        assert.notEqual(newPlan.id, firstPlan.id);
        assert.notEqual(newPlan.runId, firstPlan.runId);
        assert.deepEqual(newPlan.steps, [
          { id: "task-1", text: "Inspected", status: "completed" },
          { id: "task-2", text: "Implement", status: "pending" },
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
  it.effect("removes deleted tasks without resurrecting them on later updates or turns", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskToolHarness;
      yield* harness.startTurn();
      yield* harness.call(createTask("1", "Discard"));
      yield* harness.call(createTask("2", "Keep"));
      yield* harness.call(updateTask({ taskId: "1", status: "deleted" }));
      yield* harness.call(updateTask({ taskId: "1", status: "pending" }));
      yield* harness.finishTurn();
      assert.lengthOf(harness.plans(), 3);
      assert.deepEqual(harness.plans().at(-1)?.steps, [
        { id: "task-2", text: "Keep", status: "pending" },
      ]);

      yield* harness.startTurn();
      yield* harness.call(updateTask({ taskId: "2", status: "in_progress" }));
      yield* harness.finishTurn();
      assert.deepEqual(harness.plans().at(-1)?.steps, [
        { id: "task-2", text: "Keep", status: "running" },
      ]);
      for (const plan of harness.plans().slice(2)) {
        assert.isFalse(plan.steps.some((step) => step.id === "task-1"));
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
  it.effect.each([
    {
      tool: updateTask({ taskId: "2", status: "completed" }),
      listId: undefined,
      directory: WAKE_NATIVE_SESSION,
      status: "completed",
    },
    {
      tool: createTask("2", "Implement"),
      listId: " list/ID ",
      directory: "list-ID",
      status: "pending",
    },
  ] as const)(
    "recovers persisted tasks on the first $tool.name after restart",
    ({ tool, listId, directory, status }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const harness = yield* makeTaskToolHarnessWithOptions({ CLAUDE_CODE_TASK_LIST_ID: listId });
        const tasksDir = `${harness.configDir}/tasks/${directory}`;
        yield* fs.makeDirectory(tasksDir, { recursive: true });
        // The native tool has already written its result before emitting the SDK frame.
        for (const task of [
          { id: "1", subject: "Inspect", status: "completed" },
          { id: "2", subject: "Implement", status },
          { id: "3", subject: "Internal", status: "pending", metadata: { _internal: true } },
        ]) {
          yield* fs.writeFileString(
            `${tasksDir}/${task.id}.json`,
            JSON.stringify({ description: "", blocks: [], blockedBy: [], ...task }),
          );
        }
        yield* fs.writeFileString(`${tasksDir}/4.json`, "{");
        yield* fs.makeDirectory(`${tasksDir}/5.json`);

        yield* harness.startTurn();
        yield* harness.call(tool);
        assert.equal((yield* harness.finishTurn()).status, "completed");
        assert.deepEqual(
          harness.plans().map((plan) => plan.steps),
          [
            [
              { id: "task-1", text: "Inspect", status: "completed" },
              { id: "task-2", text: "Implement", status },
            ],
          ],
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
  it.effect(
    "publishes an empty task list when the first TaskUpdate after restart deletes the last task",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const harness = yield* makeTaskToolHarness;
        const tasksDir = `${harness.configDir}/tasks/${WAKE_NATIVE_SESSION}`;
        // Claude has removed the task file before emitting the SDK frame.
        yield* fs.makeDirectory(tasksDir, { recursive: true });
        yield* fs.writeFileString(`${tasksDir}/.highwatermark`, "1");

        yield* harness.startTurn();
        yield* harness.call(updateTask({ taskId: "1", status: "deleted" }));
        assert.equal((yield* harness.finishTurn()).status, "completed");
        assert.deepEqual(
          harness.plans().map((plan) => plan.steps),
          [[]],
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
  it.effect("replaces task state with TaskList, including an empty list", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskToolHarness;
      yield* harness.startTurn();
      yield* harness.call(createTask("1", "Stale"));
      yield* harness.call({
        name: "TaskList",
        input: {},
        output: {
          tasks: [
            { id: "2", subject: "Queued", status: "pending", blockedBy: [] },
            { id: "3", subject: "Working", status: "in_progress", blockedBy: [] },
            { id: "4", subject: "Done", status: "completed", blockedBy: [] },
          ],
        },
      });
      yield* harness.call(updateTask({ taskId: "1", status: "in_progress" }));
      yield* harness.call(updateTask({ taskId: "2", status: "in_progress" }));
      yield* harness.call({ name: "TaskList", input: {}, output: { tasks: [] } });
      yield* harness.call(updateTask({ taskId: "2", status: "pending" }));
      yield* harness.finishTurn();
      const plans = harness.plans();
      assert.lengthOf(plans, 4);
      assert.deepEqual(plans[1]?.steps, [
        { id: "task-2", text: "Queued", status: "pending" },
        { id: "task-3", text: "Working", status: "running" },
        { id: "task-4", text: "Done", status: "completed" },
      ]);
      assert.deepEqual(plans[2]?.steps, [
        { id: "task-2", text: "Queued", status: "running" },
        { id: "task-3", text: "Working", status: "running" },
        { id: "task-4", text: "Done", status: "completed" },
      ]);
      assert.deepEqual(plans[3]?.steps, []);
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
  it.effect("applies subagent task tools to the parent turn's shared task list", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskToolHarness;
      yield* harness.startTurn();
      yield* harness.call(createTask("1", "Main task"));
      yield* harness.launchSubagent("tool-parent-agent");
      const child = { parentToolUseId: "tool-parent-agent" };
      yield* harness.call(updateTask({ taskId: "1", status: "completed" }), child);
      yield* harness.call(createTask("2", "Child task"), child);
      yield* harness.call(
        {
          name: "TaskUpdate",
          input: { taskId: "2", status: "completed" },
          output: {
            success: false,
            taskId: "2",
            updatedFields: [],
            error: "Tests must pass before completing.",
          },
        },
        child,
      );
      yield* harness.call(updateTask({ taskId: "2", status: "in_progress" }), {
        ...child,
        isError: true,
      });
      // A cancelled call never ran, even without `is_error`.
      yield* harness.call(updateTask({ taskId: "2", status: "completed" }), {
        ...child,
        nonExecutionKind: "cancelled",
      });
      yield* harness.finishTurn();
      const plans = harness.plans();
      assert.lengthOf(plans, 3);
      assert.equal(new Set(plans.map((plan) => plan.id)).size, 1);
      assert.deepEqual(plans.at(-1)?.steps, [
        { id: "task-1", text: "Main task", status: "completed" },
        { id: "task-2", text: "Child task", status: "pending" },
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
  it.effect("recovers persisted tasks when a subagent's TaskList comes first", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const harness = yield* makeTaskToolHarness;
      const tasksDir = `${harness.configDir}/tasks/${WAKE_NATIVE_SESSION}`;
      yield* fs.makeDirectory(tasksDir, { recursive: true });
      yield* fs.writeFileString(
        `${tasksDir}/1.json`,
        JSON.stringify({ id: "1", subject: "Inspect", status: "pending", blockedBy: [] }),
      );

      yield* harness.startTurn();
      yield* harness.launchSubagent("tool-parent-agent");
      yield* harness.call(
        { name: "TaskList", input: {}, output: { tasks: [] } },
        { parentToolUseId: "tool-parent-agent" },
      );
      yield* harness.call(updateTask({ taskId: "1", status: "completed" }));
      yield* harness.finishTurn();
      assert.deepEqual(harness.plans().at(-1)?.steps, [
        { id: "task-1", text: "Inspect", status: "completed" },
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

  // regression: #14964 structured task output attaches to exactly one tool result
});
