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
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  makeClaudeTestTurnInput,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeAssistantTextFrame,
  makeAssistantErrorFrame,
  makeResultFrame,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
  usageStreamFrame,
  usageSnapshotFrame,
  zeroUsage,
  reportedContextTokens,
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
    { status: 503, cooldown: "4m 6s", seconds: 246 },
    { status: 503, cooldown: "1h 2m 3s", seconds: 3723 },
    { status: 503, cooldown: "7s", seconds: 7 },
    { status: 503, cooldown: "0s", seconds: 0 },
    { status: 503, cooldown: "unknown", seconds: 0 },
    { status: 503, cooldown: "999999999999999999999999h", seconds: 0 },
    { status: 503, cooldown: "4m 6s", seconds: 0, errorType: "overloaded_error" },
    { status: 401, cooldown: "4m 6s", seconds: 0 },
  ])("recovers wrapped gateway limits with status $status and cooldown $cooldown", (input) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-gateway-limit"),
          text: "Continue.",
          attachments: [],
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000652",
          error: "server_error",
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000653",
          result: `API Error: ${input.status} [claude/claude-opus-5-5] [429]: {"type":"error","error":{"type":"${input.errorType ?? "rate_limit_error"}","message":"Please try again later."}} (reset after ${input.cooldown}).`,
          terminalReason: "api_error",
          isError: true,
          apiErrorStatus: input.status,
        }),
      ]);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, input.seconds > 0 ? "usage_limit" : "provider_error");
      if (input.seconds > 0) {
        assert.equal(terminal.failure.retryable, true);
        assert.equal(
          terminal.failure.resetAt,
          DateTime.formatIso(
            DateTime.makeUnsafe(DateTime.toEpochMillis(now) + input.seconds * 1_000),
          ),
        );
      } else {
        assert.isUndefined(terminal.failure.resetAt);
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
  it.effect.each([
    { cooldown: " (reset after 1h2m3s)", seconds: 3723 },
    { cooldown: " (reset after 4m 6s) (last error: rate limited)", seconds: 246 },
    { cooldown: "", seconds: 0 },
  ])("keeps a gateway's reset on a direct 429 with cooldown '$cooldown'", (input) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-direct-gateway-limit"),
          text: "Continue.",
          attachments: [],
        }),
      );
      // An API-key session reports a gateway 429 only as text, with no rate_limit_info.
      const result = `API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down${input.cooldown}`;
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000654",
          error: "rate_limit",
          text: result,
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000655",
          result,
          terminalReason: "api_error",
          isError: true,
          apiErrorStatus: 429,
        }),
      ]);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, "usage_limit");
      assert.equal(
        terminal.failure.resetAt,
        input.seconds > 0
          ? DateTime.formatIso(
              DateTime.makeUnsafe(DateTime.toEpochMillis(now) + input.seconds * 1_000),
            )
          : null,
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
  );
  it.effect("keeps the measured context when a usage limit ends the turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-limit-context"),
          text: "Continue.",
          attachments: [],
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000660", text: "Working." }),
      );
      // The CLI answers a 429 with a locally generated frame that reports no usage.
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "assistant",
          message: {
            model: "<synthetic>",
            id: "00000000-0000-4000-8000-000000000661",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "You've hit your session limit" }],
            stop_reason: "stop_sequence",
            stop_sequence: "",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          error: "rate_limit",
          uuid: "00000000-0000-4000-8000-000000000661",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000662",
          result: "You've hit your session limit",
          terminalReason: "api_error",
          isError: true,
          apiErrorStatus: 429,
        }),
      );
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      const reportedContext = harness.events.flatMap((event) =>
        event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
          ? [event.providerTurn.tokenUsage.usedTokens]
          : [],
      );
      assert.deepEqual(reportedContext, [2]);
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
  it.effect("reports context from final stream usage when the request starts at zero", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-zero-start-usage"),
          text: "Continue.",
          attachments: [],
        }),
      );
      // Some Anthropic-compatible proxies report zero usage at message_start
      // and the real counts on the final message_delta.
      const frames = [
        usageStreamFrame({
          type: "message_start",
          message: { id: "msg_first", usage: zeroUsage },
        }),
        usageSnapshotFrame("msg_first", "00000000-0000-4000-8000-000000000670", zeroUsage),
        usageStreamFrame(
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { ...zeroUsage, input_tokens: 999_999, output_tokens: 9 },
          },
          "child-tool",
        ),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { ...zeroUsage, input_tokens: 37_939, output_tokens: 184 },
        }),
        usageSnapshotFrame("msg_first", "00000000-0000-4000-8000-000000000671", zeroUsage),
        usageStreamFrame({
          type: "message_start",
          message: { id: "msg_second", usage: zeroUsage },
        }),
        usageSnapshotFrame("msg_second", "00000000-0000-4000-8000-000000000672", zeroUsage),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: null, output_tokens: 12 },
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000673", result: "Done." }),
      ];
      for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "completed");
      assert.deepEqual(reportedContextTokens(harness.events), [38_123]);
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
  it.effect("measures a model outside the catalog against the window Claude reports", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const modelSelection = {
        instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
        model: "gateway-model",
      } satisfies ModelSelection;
      assert.strictEqual(harness.runtime.getModelContextWindow?.(modelSelection), undefined);
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-reported-context-window"),
          text: "Continue.",
          attachments: [],
          modelSelection,
        }),
      );
      const usage = { ...zeroUsage, input_tokens: 9_667, output_tokens: 2 };
      const frames = [
        usageStreamFrame({ type: "message_start", message: { id: "msg_gateway", usage } }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000680",
          result: "OK",
          modelUsage: {
            "gateway-model": {
              inputTokens: 9_667,
              outputTokens: 2,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0,
              contextWindow: 1_048_576,
              maxOutputTokens: 32_000,
            },
          },
        }),
      ];
      for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "completed");
      const windows = harness.events.flatMap((event) =>
        event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
          ? [event.providerTurn.tokenUsage.maxTokens]
          : [],
      );
      assert.deepEqual(windows, [null, 1_048_576]);
      assert.strictEqual(harness.runtime.getModelContextWindow?.(modelSelection), 1_048_576);
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
  it.effect("merges cumulative stream usage into the message_start counts", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions({
        settings: { ...DEFAULT_CLAUDE_SETTINGS, autoCompactWindow: "150000" },
      });
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-merged-stream-usage"),
          text: "Continue.",
          attachments: [],
        }),
      );
      const startUsage = {
        input_tokens: 10,
        output_tokens: 1,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 1_000,
      };
      const frames = [
        usageStreamFrame({
          type: "message_start",
          message: { id: "msg_native", usage: startUsage },
        }),
        usageSnapshotFrame("msg_native", "00000000-0000-4000-8000-000000000680", startUsage),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: null, stop_sequence: null },
          usage: { input_tokens: null, output_tokens: 20 },
        }),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            input_tokens: 25,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1_000,
          },
        }),
        usageSnapshotFrame("msg_native", "00000000-0000-4000-8000-000000000681", startUsage),
        claudeSdkFrame({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 1_075, post_tokens: 400 },
          uuid: "00000000-0000-4000-8000-000000000682",
          session_id: WAKE_NATIVE_SESSION,
        }),
        usageSnapshotFrame("msg_native", "00000000-0000-4000-8000-000000000684", startUsage),
        usageStreamFrame({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: null, output_tokens: 60 },
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000683", result: "Done." }),
      ];
      for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "completed");
      assert.deepEqual(reportedContextTokens(harness.events), [1_211, 1_230, 1_075, 400]);
      assert.deepEqual(
        harness.events.flatMap((event) =>
          event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
            ? [event.providerTurn.tokenUsage.autoCompactThreshold]
            : [],
        ),
        [117_000, 117_000, 117_000, 117_000],
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
  );
  it.effect.each([
    { autoCompactWindow: "", model: "claude-sonnet-4-6", threshold: undefined },
    { autoCompactWindow: "150000", model: "claude-sonnet-4-6", threshold: 117_000 },
    { autoCompactWindow: "200000", model: "claude-sonnet-4-6", threshold: undefined },
    { autoCompactWindow: "650000", model: "claude-sonnet-4-6", threshold: undefined },
    { autoCompactWindow: "650000", model: "uncatalogued-model", threshold: 617_000 },
  ])(
    "ignores stale snapshots after compaction and reports threshold $autoCompactWindow for $model",
    ({ autoCompactWindow, model, threshold }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({
          settings: { ...DEFAULT_CLAUDE_SETTINGS, autoCompactWindow },
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-snapshot-usage-compaction"),
            text: "Continue.",
            attachments: [],
            modelSelection: { ...CLAUDE_TEST_MODEL_SELECTION, model },
          }),
        );
        const usage = { ...zeroUsage, input_tokens: 1_000, output_tokens: 75 };
        const frames = [
          usageSnapshotFrame("msg_fallback", "00000000-0000-4000-8000-000000000790", usage),
          claudeSdkFrame({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 1_075, post_tokens: 400 },
            uuid: "00000000-0000-4000-8000-000000000791",
            session_id: WAKE_NATIVE_SESSION,
          }),
          usageSnapshotFrame("msg_fallback", "00000000-0000-4000-8000-000000000792", usage),
          // A new request after the boundary reports the compacted context.
          usageSnapshotFrame("msg_after", "00000000-0000-4000-8000-000000000793", {
            ...zeroUsage,
            input_tokens: 450,
            output_tokens: 10,
          }),
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000794", result: "Done." }),
        ];
        for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "completed");
        assert.deepEqual(reportedContextTokens(harness.events), [1_075, 400, 460]);
        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
              ? [event.providerTurn.tokenUsage.autoCompactThreshold]
              : [],
          ),
          [threshold, threshold, threshold],
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
  );
  it.effect("shows a hook-dropped Claude prompt once and skips info-level lines", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-hook-dropped-prompt-attempt"),
          text: "Deploy to production",
          attachments: [],
        }),
      );
      const notice = "Prompt dropped by a hook: Deploys are frozen until Monday.";
      const uuid = "00000000-0000-4000-8000-000000000305";
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "system",
          subtype: "informational",
          content: "Started in the background: agent-1",
          level: "info",
          session_id: WAKE_NATIVE_SESSION,
          uuid: "00000000-0000-4000-8000-000000000307",
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "system",
          subtype: "informational",
          content: notice,
          level: "warning",
          prevent_continuation: true,
          session_id: WAKE_NATIVE_SESSION,
          uuid,
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000306",
          result: notice,
          numTurns: 0,
          terminalReason: null,
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const notices = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
          ? [event.turnItem]
          : [],
      );
      assert.lengthOf(notices, 1);
      assert.equal(notices[0]?.message, notice);
      assert.equal(notices[0]?.status, "completed");
      assert.equal(notices[0]?.nativeItemRef?.nativeId, uuid);
      assert.equal(harness.terminalEvents()[0]?.status, "completed");
      assert.isFalse(
        harness.events.some(
          (event) => event.type === "message.updated" && event.message.role === "assistant",
        ),
      );
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
});
