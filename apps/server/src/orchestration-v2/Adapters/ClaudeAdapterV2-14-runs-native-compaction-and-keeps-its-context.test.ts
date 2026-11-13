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
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeResultFrame,
  turnOneResult,
  wakeTurnInit,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
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
  it.effect(
    "runs native compaction and keeps its context watermark separate from billed usage",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const compact = harness.runtime.compactThread;
        assert.isDefined(compact);
        if (compact === undefined) return;
        yield* compact(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("claude-native-compact-attempt"),
            modelSelection: {
              instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
              model: "gateway-model",
            },
            text: " /COMPACT ",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "manual", pre_tokens: 1500, post_tokens: 400 },
            uuid: "00000000-0000-4000-8000-000000000201",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000202",
            result: "Compacted conversation.",
            modelUsage: {
              "gateway-model": {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                webSearchRequests: 0,
                costUSD: 0,
                contextWindow: 200_000,
                maxOutputTokens: 32_000,
              },
            },
          }),
        );
        yield* Queue.take(harness.terminalReceipts);

        assert.deepEqual(harness.offeredMessages[0]?.message.content, "/compact");
        const compaction = harness.events.find(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        );
        assert.isDefined(compaction);
        if (compaction?.type === "turn_item.updated" && compaction.turnItem.type === "compaction") {
          assert.equal(compaction.turnItem.beforeTokenCount, 1500);
          assert.equal(compaction.turnItem.afterTokenCount, 400);
          assert.equal(compaction.turnItem.status, "completed");
        }
        const watermark = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.tokenUsage?.usedTokens === 400,
        );
        assert.isDefined(watermark);
        const windows = harness.events.flatMap((event) =>
          event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
            ? [event.providerTurn.tokenUsage.maxTokens]
            : [],
        );
        assert.deepEqual(windows, [null, 200_000]);
        const completed = harness.events.findLast(
          (event) => event.type === "provider_turn.updated",
        );
        assert.equal(completed?.type, "provider_turn.updated");
        if (completed?.type === "provider_turn.updated") {
          assert.deepEqual(completed.providerTurn.turnTokenUsage, {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            otherUsage: { inputTokens: 0, outputTokens: 0 },
          });
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            IdAllocator.layer,
            McpProviderSessions.layer,
          ),
        ),
      ),
  );
  it.effect("shows automatic compaction before its boundary and completes the same item", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const observeCompactions = Effect.fnUntraced(function* (uuid: string) {
        // A later notice receipt confirms the event subscriber consumed preceding updates.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "informational",
            content: "Context checkpoint",
            level: "warning",
            session_id: WAKE_NATIVE_SESSION,
            uuid,
          }),
        );
        yield* Queue.take(harness.systemNoticeReceipts);
        return harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        );
      });
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("claude-auto-compact-attempt"),
          text: "Continue working.",
          attachments: [],
        }),
      );
      for (const index of [1, 2]) {
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: `00000000-0000-4000-8000-00000000021${index}`,
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
      }
      const beforeBoundary = yield* observeCompactions("00000000-0000-4000-8000-000000000215");
      assert.lengthOf(beforeBoundary, 1);
      const running = beforeBoundary[0]!;
      assert.equal(running.status, "running");
      assert.isNull(running.completedAt);
      assert.isNotNull(running.startedAt);

      yield* TestClock.adjust(1_000);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "success",
          uuid: "00000000-0000-4000-8000-000000000222",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const reported = yield* observeCompactions("00000000-0000-4000-8000-000000000223");
      assert.lengthOf(reported, 2);
      assert.equal(reported[1]?.id, running.id);
      assert.equal(reported[1]?.status, "completed");
      assert.isUndefined(reported[1]?.afterTokenCount);
      assert.isEmpty(harness.terminalEvents());
      yield* TestClock.adjust(1_000);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 1500, post_tokens: 400 },
          uuid: "00000000-0000-4000-8000-000000000213",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const afterBoundary = yield* observeCompactions("00000000-0000-4000-8000-000000000216");
      assert.lengthOf(afterBoundary, 3);
      const completed = afterBoundary[2]!;
      assert.equal(completed.status, "completed");
      assert.equal(completed.id, running.id);
      assert.equal(completed.ordinal, running.ordinal);
      assert.deepEqual(completed.startedAt, running.startedAt);
      assert.equal(completed.beforeTokenCount, 1500);
      assert.equal(completed.afterTokenCount, 400);
      assert.deepEqual(completed.completedAt, reported[1]?.completedAt);

      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 2000, post_tokens: 500 },
          uuid: "00000000-0000-4000-8000-000000000217",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "00000000-0000-4000-8000-000000000218",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const nextCompactions = yield* observeCompactions("00000000-0000-4000-8000-000000000219");
      assert.lengthOf(nextCompactions, 5);
      const boundaryOnly = nextCompactions[3]!;
      const nextRunning = nextCompactions[4]!;
      assert.equal(boundaryOnly.status, "completed");
      assert.notEqual(boundaryOnly.id, completed.id);
      assert.isAbove(boundaryOnly.ordinal, completed.ordinal);
      assert.equal(boundaryOnly.beforeTokenCount, 2000);
      assert.equal(boundaryOnly.afterTokenCount, 500);
      assert.equal(nextRunning.status, "running");
      assert.notEqual(nextRunning.id, boundaryOnly.id);
      assert.isAbove(nextRunning.ordinal, boundaryOnly.ordinal);

      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "default",
          uuid: "00000000-0000-4000-8000-000000000233",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      assert.deepEqual(
        yield* observeCompactions("00000000-0000-4000-8000-000000000234"),
        nextCompactions,
      );

      let retryRunning = nextRunning;
      for (const [index, outcome] of [
        { compact_result: "failed", compact_error: "Temporary compaction failure." },
        {},
      ].entries()) {
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: null,
            ...outcome,
            uuid: `00000000-0000-4000-8000-00000000024${index}`,
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const stopped = yield* observeCompactions(`00000000-0000-4000-8000-00000000025${index}`);
        assert.lengthOf(stopped, 6 + index * 2);
        const settled = stopped.at(-1)!;
        assert.equal(settled.id, retryRunning.id);
        assert.equal(settled.ordinal, retryRunning.ordinal);
        assert.deepEqual(settled.startedAt, retryRunning.startedAt);
        assert.equal(
          settled.status,
          outcome.compact_result === "failed" ? "failed" : "interrupted",
        );
        assert.equal(
          settled.title,
          outcome.compact_result === "failed"
            ? "Context compaction failed"
            : "Context compaction stopped",
        );
        assert.isNotNull(settled.completedAt);
        assert.isEmpty(harness.terminalEvents());

        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: `00000000-0000-4000-8000-00000000026${index}`,
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const retried = yield* observeCompactions(`00000000-0000-4000-8000-00000000027${index}`);
        assert.lengthOf(retried, stopped.length + 1);
        retryRunning = retried.at(-1)!;
        assert.equal(retryRunning.status, "running");
        assert.notEqual(retryRunning.id, settled.id);
        assert.isAbove(retryRunning.ordinal, settled.ordinal);
      }

      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 3000, post_tokens: 600 },
          uuid: "00000000-0000-4000-8000-000000000220",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      const allCompactions = yield* observeCompactions("00000000-0000-4000-8000-000000000221");
      assert.lengthOf(allCompactions, 10);
      assert.equal(allCompactions[9]?.id, retryRunning.id);
      assert.equal(allCompactions[9]?.ordinal, retryRunning.ordinal);
      assert.equal(allCompactions[9]?.status, "completed");
      assert.equal(allCompactions[9]?.beforeTokenCount, 3000);
      assert.equal(allCompactions[9]?.afterTokenCount, 600);

      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000214",
          result: "Work complete.",
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
      assert.deepEqual(
        harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        ),
        allCompactions,
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
  it.effect.each([
    { outcome: "result", turnStatus: "completed", itemStatus: "failed" },
    { outcome: "interrupt", turnStatus: "interrupted", itemStatus: "interrupted" },
    { outcome: "query_exit", turnStatus: "failed", itemStatus: "failed" },
  ] as const)(
    "settles unfinished compaction before the $outcome terminal receipt",
    ({ outcome, turnStatus, itemStatus }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({
          close: (sdkMessages) => Queue.shutdown(sdkMessages),
        });
        const attemptId = RunAttemptId.make(`claude-compact-${outcome}`);
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId,
            text: "Continue.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: "00000000-0000-4000-8000-000000000221",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        if (outcome === "query_exit") {
          yield* Queue.shutdown(harness.sdkMessages);
        } else if (outcome === "interrupt") {
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${attemptId}`,
            }),
          });
        } else {
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000222",
              result: "Stopped before the boundary.",
            }),
          );
        }
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, turnStatus);
        const updates = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(updates, 2);
        const [running, settled] = updates;
        assert.equal(running?.status, "running");
        assert.equal(settled?.status, itemStatus);
        assert.equal(settled?.id, running?.id);
        assert.equal(settled?.ordinal, running?.ordinal);
        assert.deepEqual(settled?.startedAt, running?.startedAt);
        assert.isNotNull(settled?.completedAt);
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
  it.effect("names the notebook a Claude NotebookEdit changed", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-notebook-edit"),
          text: "Fix the notebook",
          attachments: [],
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "assistant",
          uuid: "00000000-0000-4000-8000-000000000604",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            id: "msg_notebook_edit",
            model: "claude-sonnet-4-6",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "notebook",
                name: "NotebookEdit",
                input: {
                  notebook_path: "/workspace/analysis.ipynb",
                  cell_id: "c1",
                  new_source: "print(1)",
                },
              },
            ],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "user",
          uuid: "00000000-0000-4000-8000-000000000605",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "notebook", content: "Updated cell c1" }],
          },
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000606", result: "Done" }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const item = harness.events
        .flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "notebook"
            ? [event.turnItem]
            : [],
        )
        .at(-1);
      assert.equal(item?.type, "file_change");
      if (item?.type === "file_change") assert.equal(item.fileName, "/workspace/analysis.ipynb");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          IdAllocator.layer,
          McpProviderSessions.layer,
        ),
      ),
    ),
  );
  it.effect.each(["claude-haiku-4-5-20251001", "claude-sonnet-4-6"])(
    "renegotiates auto only when switching API models after fallback to default: %s",
    (nextModel) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
        const modelSelection = {
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          model: "claude-haiku-4-5-20251001",
        };
        const turnInput = {
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attachments: [],
          modelSelection,
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            ...CLAUDE_TEST_RUNTIME_POLICY,
            runtimeMode: "auto",
          }),
        };
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            ...turnInput,
            attemptId: RunAttemptId.make("attempt-claude-auto-fallback-1"),
            text: "Hello.",
          }),
        );
        const openedOptions = harness.getOpenedOptions();
        assert.equal(openedOptions?.permissionMode, "auto");
        yield* harness.offerAndWait(claudeSdkFrame({ ...wakeTurnInit, permissionMode: "default" }));
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* Queue.take(harness.terminalReceipts);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            ...turnInput,
            modelSelection: { ...modelSelection, model: nextModel },
            attemptId: RunAttemptId.make("attempt-claude-auto-fallback-2"),
            providerTurnOrdinal: 2,
            text: "Continue.",
          }),
        );
        if (nextModel === modelSelection.model) {
          assert.strictEqual(harness.getOpenedOptions(), openedOptions);
          assert.lengthOf(harness.processQueues, 1);
        } else {
          const resumedOptions = harness.getOpenedOptions();
          assert.notStrictEqual(resumedOptions, openedOptions);
          assert.equal(resumedOptions?.model, nextModel);
          assert.equal(resumedOptions?.resume, WAKE_NATIVE_SESSION);
          assert.isUndefined(resumedOptions?.sessionId);
          assert.equal(resumedOptions?.permissionMode, "auto");
          assert.lengthOf(harness.processQueues, 2);
        }
        assert.lengthOf(harness.offeredMessages, 2);
        assert.deepEqual(harness.permissionModeChanges, []);
        assert.deepEqual(harness.liveSelectionChanges, []);
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
