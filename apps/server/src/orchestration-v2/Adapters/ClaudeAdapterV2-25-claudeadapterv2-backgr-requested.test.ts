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
  CUSTOM_MODEL_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  makeClaudeTestTurnInput,
  options,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeResultFrame,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
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
  it.effect.each([
    "requested",
    "observed-before",
    "observed-after",
    "synthetic-after",
    "inherit",
    "unknown",
  ] as const)(
    "records the subagent model from %s without inheriting the parent override",
    (source) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const toolUseId = "toolu-subagent-model";
          const parentModel = "claude-opus-4-6";
          // Claude stamps its error frames as "<synthetic>", regardless of the subagent model.
          const observedModel =
            source === "synthetic-after" ? "<synthetic>" : "claude-haiku-4-5-20251001";
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-subagent-model"),
              text: "Spawn a Haiku subagent.",
              attachments: [],
              modelSelection: { ...CLAUDE_TEST_MODEL_SELECTION, model: parentModel },
            }),
          );
          const observed = claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: toolUseId,
            message: {
              model: observedModel,
              id: "msg_subagent_model_observed",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Solving." }],
            },
            uuid: "00000000-0000-4000-8000-000000000206",
            session_id: WAKE_NATIVE_SESSION,
          });
          if (source === "observed-before") yield* Queue.offer(harness.sdkMessages, observed);
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "assistant",
              parent_tool_use_id: null,
              message: {
                model: parentModel,
                id: "msg_subagent_model_launch",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: toolUseId,
                    name: "Agent",
                    input: {
                      description: "Haiku puzzle",
                      subagent_type: "general-purpose",
                      ...(source === "unknown"
                        ? {}
                        : { model: source === "inherit" ? "inherit" : "haiku" }),
                      prompt: "Solve the puzzle.",
                    },
                  },
                ],
              },
              uuid: "00000000-0000-4000-8000-000000000209",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "task-subagent-model",
              tool_use_id: toolUseId,
              description: "Haiku puzzle",
              task_type: "local_agent",
              uuid: "00000000-0000-4000-8000-000000000207",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          if (source === "observed-after" || source === "synthetic-after") {
            yield* Queue.offer(harness.sdkMessages, observed);
          }
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000208",
              result: "Spawned the subagent.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          const subagents = harness.events.filter((event) => event.type === "subagent.updated");
          const observedSlug = "claude-haiku-4-5";
          const initialModel =
            source === "observed-before"
              ? observedSlug
              : source === "inherit"
                ? parentModel
                : source === "unknown"
                  ? null
                  : "claude-haiku-5-5";
          assert.equal(subagents[0]?.subagent.model, initialModel);
          assert.equal(
            subagents.at(-1)?.subagent.model,
            source.startsWith("observed") ? observedSlug : initialModel,
          );
          const child = harness.events.find((event) => event.type === "app_thread.created");
          assert.equal(child?.appThread.modelSelection?.model, initialModel ?? parentModel);
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
  it.effect("resolves a subagent's model and effort against the instance's custom models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TUNED_TOOL_USE_ID = "toolu-effort-custom-tuned";
        const SHADOW_TOOL_USE_ID = "toolu-effort-custom-shadow";
        const harness = yield* makeWakeHarnessWithOptions({
          settings: CUSTOM_MODEL_CLAUDE_SETTINGS,
        });
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-subagent-custom-effort"),
            text: "Spawn subagents on custom models.",
            attachments: [],
          }),
        );
        for (const frame of [
          claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
              model: CLAUDE_TEST_MODEL_SELECTION.model,
              id: "msg_custom_effort_launch",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: TUNED_TOOL_USE_ID,
                  name: "Agent",
                  input: {
                    description: "Tuned",
                    subagent_type: "general-purpose",
                    model: "claude-custom-tuned",
                    effort: "brutal",
                    prompt: "Check one thing.",
                  },
                },
                {
                  type: "tool_use",
                  id: SHADOW_TOOL_USE_ID,
                  name: "Agent",
                  input: {
                    description: "Shadow",
                    subagent_type: "general-purpose",
                    model: "opus",
                    prompt: "Check another thing.",
                  },
                },
              ],
            },
            uuid: "00000000-0000-4000-8000-000000000231",
            session_id: WAKE_NATIVE_SESSION,
          }),
          ...[TUNED_TOOL_USE_ID, SHADOW_TOOL_USE_ID].map((id, index) =>
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: `task-${id}`,
              tool_use_id: id,
              description: id,
              task_type: "local_agent",
              uuid: `00000000-0000-4000-8000-00000000023${index + 2}`,
              session_id: WAKE_NATIVE_SESSION,
            }),
          ),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000234",
            result: "Spawned the subagents.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* Queue.take(harness.terminalReceipts);

        const selections = Object.fromEntries(
          harness.events.flatMap((event) =>
            event.type === "subagent.updated"
              ? [[event.subagent.nativeTaskRef?.nativeId, event.subagent.modelSelection] as const]
              : [],
          ),
        );
        const instanceId = CLAUDE_TEST_MODEL_SELECTION.instanceId;
        assert.deepEqual(selections, {
          [`task-${TUNED_TOOL_USE_ID}`]: {
            instanceId,
            model: "claude-custom-tuned",
            options: [{ id: "effort", value: "brutal" }],
          },
          [`task-${SHADOW_TOOL_USE_ID}`]: { instanceId, model: "opus" },
        });
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
  it.effect("gives a nested subagent its own effort, else the one its owner runs at", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const OUTER_TOOL_USE_ID = "toolu-effort-outer";
        const INHERITING_TOOL_USE_ID = "toolu-effort-nested-inheriting";
        const OVERRIDING_TOOL_USE_ID = "toolu-effort-nested-overriding";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const parentSelection = {
          instanceId: CLAUDE_TEST_MODEL_SELECTION.instanceId,
          model: "claude-opus-4-6",
          options: [{ id: "effort", value: "high" }],
        } satisfies ModelSelection;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-subagent-nested-effort"),
            text: "Spawn a subagent that spawns two more.",
            attachments: [],
            modelSelection: parentSelection,
          }),
        );
        const agentCall = (id: string, effort?: string) => ({
          type: "tool_use" as const,
          id,
          name: "Agent",
          input: {
            description: id,
            subagent_type: "general-purpose",
            ...(effort === undefined ? {} : { effort }),
            prompt: "Check one thing.",
          },
        });
        const taskStarted = (id: string, uuid: string) =>
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: `task-${id}`,
            tool_use_id: id,
            description: id,
            task_type: "local_agent",
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        for (const frame of [
          claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
              model: parentSelection.model,
              id: "msg_nested_effort_outer_launch",
              type: "message",
              role: "assistant",
              content: [agentCall(OUTER_TOOL_USE_ID, "low")],
            },
            uuid: "00000000-0000-4000-8000-000000000221",
            session_id: WAKE_NATIVE_SESSION,
          }),
          taskStarted(OUTER_TOOL_USE_ID, "00000000-0000-4000-8000-000000000222"),
          claudeSdkFrame({
            type: "assistant",
            parent_tool_use_id: OUTER_TOOL_USE_ID,
            message: {
              model: parentSelection.model,
              id: "msg_nested_effort_inner_launch",
              type: "message",
              role: "assistant",
              content: [
                agentCall(INHERITING_TOOL_USE_ID),
                agentCall(OVERRIDING_TOOL_USE_ID, "max"),
              ],
            },
            uuid: "00000000-0000-4000-8000-000000000223",
            session_id: WAKE_NATIVE_SESSION,
          }),
          taskStarted(INHERITING_TOOL_USE_ID, "00000000-0000-4000-8000-000000000224"),
          taskStarted(OVERRIDING_TOOL_USE_ID, "00000000-0000-4000-8000-000000000225"),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000226",
            result: "Spawned the subagents.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* Queue.take(harness.terminalReceipts);

        const efforts = new Map(
          harness.events.flatMap((event) =>
            event.type === "subagent.updated"
              ? [
                  [
                    event.subagent.nativeTaskRef?.nativeId,
                    getModelSelectionStringOptionValue(event.subagent.modelSelection, "effort"),
                  ] as const,
                ]
              : [],
          ),
        );
        assert.deepEqual(Object.fromEntries(efforts), {
          [`task-${OUTER_TOOL_USE_ID}`]: "low",
          [`task-${INHERITING_TOOL_USE_ID}`]: "low",
          [`task-${OVERRIDING_TOOL_USE_ID}`]: "max",
        });
        const childEfforts = harness.events.flatMap((event) =>
          event.type === "app_thread.created" && event.appThread.id !== harness.threadId
            ? [getModelSelectionStringOptionValue(event.appThread.modelSelection, "effort")]
            : [],
        );
        assert.deepEqual(childEfforts, ["low", "low", "max"]);
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
  it.effect("extracts text from direct content-block subagent results", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-direct-content-blocks";
        const SUBAGENT_TOOL_USE_ID = "toolu-direct-content-blocks";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "subagent.updated" }
            > => event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-direct-content-blocks"),
            text: "Delegate this task.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Delegated task",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Return the result.",
            uuid: "00000000-0000-4000-8000-000000000206",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.until(() => subagentEvents().length === 1);

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: SUBAGENT_TOOL_USE_ID,
                  content: [
                    { type: "text", text: "First line." },
                    { type: "text", text: "Second line." },
                  ],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000207",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.until(() => subagentEvents().at(-1)?.subagent.status === "completed");

        assert.equal(subagentEvents().at(-1)?.subagent.result, "First line.\nSecond line.");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000208",
            result: "Delegation completed.",
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
  it.effect("keeps a foreground fork running past the placeholder result for its own launch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-foreground-fork"),
            text: "Fork this.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          makeSubagentTaskStartedFrame({
            taskId: "agent-fork",
            toolUseId: "toolu-fork",
            uuid: "00000000-0000-4000-8000-000000000901",
          }),
        );
        // Claude Code opens a foreground fork's own stream with a placeholder result for its launch.
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu-fork",
                  content: "Fork started — that fork is you.",
                },
              ],
            },
            parent_tool_use_id: "toolu-fork",
            uuid: "00000000-0000-4000-8000-000000000902",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.offerAndWait(
          makeSubagentNotificationFrame({
            taskId: "agent-fork",
            toolUseId: "toolu-fork",
            summary: "FORK-DONE",
            uuid: "00000000-0000-4000-8000-000000000903",
          }),
        );
        let settled = yield* Queue.take(harness.subagentReceipts);
        while (settled.subagent.status === "running") {
          settled = yield* Queue.take(harness.subagentReceipts);
        }
        assert.equal(settled.subagent.result, "FORK-DONE");
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
  it.effect("releases the idle pin when a post-settle subagent stops without completing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-wake-subagent-stopped";
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: "toolu-wake-subagent-stopped",
          description: "Long-running research task",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Investigate the flaky test.",
          uuid: "00000000-0000-4000-8000-000000000301",
          session_id: WAKE_NATIVE_SESSION,
        });
        const subagentStoppedNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: "toolu-wake-subagent-stopped",
          status: "stopped",
          output_file: "/tmp/task-wake-subagent-stopped.output",
          summary: "Agent was stopped before finishing.",
          uuid: "00000000-0000-4000-8000-000000000302",
          session_id: WAKE_NATIVE_SESSION,
        });

        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "subagent.updated" }
            > => event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-7a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* harness.until(() => subagentEvents().length >= 1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000303",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(harness.sdkMessages, subagentStoppedNotification);
        yield* harness.awaitContinuation(1);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000304",
            result: "The subagent was stopped.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-7b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(2);

        assert.equal(subagentEvents().at(-1)?.subagent.status, "cancelled");
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
});
