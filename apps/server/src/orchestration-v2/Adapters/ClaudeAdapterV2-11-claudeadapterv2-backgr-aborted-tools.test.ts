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
  WAKE_ASSISTANT_TEXT,
  claudeSdkFrame,
  makeAssistantTextFrame,
  makeAssistantErrorFrame,
  makeResultFrame,
  wakeAssistant,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
  lastProviderTurn,
  makeRollbackHarness,
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
  it.effect.each(
    (["aborted_tools", "aborted_streaming"] as const).flatMap((terminalReason) =>
      [
        { steered: false, queryExits: false },
        { steered: true, queryExits: false },
        { steered: true, queryExits: true },
      ].map((scenario) => ({ terminalReason, ...scenario })),
    ),
  )("handles $terminalReason (steered=$steered, exits=$queryExits)", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminalReason, steered, queryExits } = scenario;
        const harness = yield* makeWakeHarness;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attemptId = RunAttemptId.make("attempt-steering-abort");
        const input = makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId,
          text: "Audit the settings pages.",
          attachments: [],
        });
        yield* harness.runtime.startTurn(input);
        if (steered) {
          yield* harness.runtime.steerTurn({
            threadId: harness.threadId,
            runId: input.runId,
            providerThread: harness.providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${attemptId}`,
            }),
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("message-steering-abort"),
              text: "Include the hierarchy mock.",
              attachments: [],
            },
          });
          assert.equal(harness.offeredMessages[1]?.priority, "now");
        }
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000901",
            result: "",
            terminalReason,
            usage: {
              input_tokens: 600,
              output_tokens: 40,
              cache_creation_input_tokens: 500,
              cache_read_input_tokens: 2000,
            },
          }),
        );
        if (queryExits) {
          yield* Queue.shutdown(harness.sdkMessages);
        } else if (steered) {
          yield* Queue.offer(harness.sdkMessages, wakeAssistant);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000902",
              result: "Audit finished after the steer.",
              usage: {
                input_tokens: 3,
                output_tokens: 6,
                cache_creation_input_tokens: 2347,
                cache_read_input_tokens: 9455,
              },
            }),
          );
        }
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(
          terminal.status,
          queryExits ? "failed" : steered ? "completed" : "interrupted",
        );
        if (steered) {
          if (!queryExits)
            assert.isTrue(
              harness.events.some(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "assistant_message" &&
                  event.turnItem.text === WAKE_ASSISTANT_TEXT,
              ),
            );
          const completed = harness.events.findLast(
            (event) => event.type === "provider_turn.updated",
          );
          assert.deepEqual(
            completed?.type === "provider_turn.updated"
              ? completed.providerTurn.turnTokenUsage
              : undefined,
            {
              usageScope: "main_agent",
              usageStatus: queryExits ? "partial" : "complete",
              hasSubagents: false,
              inputTokens: queryExits ? 3100 : 603 + 2847 + 11455,
              outputTokens: queryExits ? 40 : 46,
              cachedInputTokens: queryExits ? 2000 : 11455,
              cacheCreationTokens: queryExits ? 500 : 2847,
              ...(queryExits ? {} : { models: ["claude-sonnet-4-6"] }),
            },
          );
        }
        assert.lengthOf(harness.terminalEvents(), 1);
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
  it.effect("announces usage-limit pauses once per window and again on a new turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      const resetsAt = Math.floor(DateTime.toEpochMillis(now) / 1000) + 7_200;
      const limit = (rateLimitType: "five_hour" | "seven_day" = "five_hour") =>
        claudeSdkFrame({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType, resetsAt },
          uuid: "00000000-0000-4000-8000-000000000601",
          session_id: WAKE_NATIVE_SESSION,
        });
      const start = (ordinal: number) =>
        harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(`attempt-claude-limit-${ordinal}`),
            providerTurnOrdinal: ordinal,
            text: "Continue.",
            attachments: [],
          }),
        );
      yield* start(1);
      yield* Queue.offer(harness.sdkMessages, limit());
      const pause = (yield* Queue.take(harness.systemNoticeReceipts)).turnItem;
      assert.equal(pause.type, "system_notice");
      if (pause.type !== "system_notice") return;
      assert.equal(
        pause.message,
        "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h.",
      );
      assert.lengthOf(harness.terminalEvents(), 0);
      yield* Queue.offerAll(harness.sdkMessages, [
        limit(),
        limit("seven_day"),
        limit(),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000602",
          result: "Recovered.",
        }),
      ]);
      yield* Queue.take(harness.terminalReceipts);
      const notices = () =>
        harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
            ? [event.turnItem]
            : [],
        );
      assert.lengthOf(notices(), 2);
      yield* start(2);
      yield* Queue.offerAll(harness.sdkMessages, [
        limit(),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000603",
          result: "Done.",
        }),
      ]);
      yield* Queue.take(harness.terminalReceipts);
      assert.lengthOf(notices(), 3);
      assert.notEqual(notices()[0]?.id, notices()[2]?.id);
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
  it.effect("keeps a later future-window event-supplied Claude reset over the embedded reset", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-embedded-limit-event"),
          text: "Continue.",
          attachments: [],
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        claudeSdkFrame({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "future_window",
            resetsAt: 1791807600,
          },
          uuid: "00000000-0000-4000-8000-000000000683",
          session_id: WAKE_NATIVE_SESSION,
        }),
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000684",
          error: "rate_limit",
          apiErrorParams: {
            rate_limit_info: {
              status: "rejected",
              rateLimitType: "five_hour",
              resetsAt: 1791804000,
            },
          },
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000685",
          result: "Usage limit reached.",
          isError: true,
          apiErrorStatus: 429,
          terminalReason: "api_error",
        }),
      ]);
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, "usage_limit");
      assert.equal(terminal.failure.resetAt, "2026-10-12T12:20:00.000Z");
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
    {
      name: "an unflagged result with surrounding whitespace",
      isError: false,
      result: "  API Error: 400 Request rejected by a safeguard.\n",
      expected: "API Error: 400 Request rejected by a safeguard.",
    },
    {
      name: "a secret crossing the truncation boundary",
      isError: true,
      result: `API Error: 400 ${"x".repeat(440)} {"token":"${"synthetic-secret".repeat(100)}"} ${"y".repeat(100)}`,
      expected: `API Error: 400 ${"x".repeat(440)} {"token":"[REDACTED]"} `.padEnd(500, "y"),
    },
    {
      name: "ordinary assistant text",
      isError: true,
      result: "I found three files.",
      expected: "Claude gave up after repeated API errors.",
    },
    {
      name: "a listed non-diagnostic error",
      isError: true,
      result: "API Error: 400 Request rejected.",
      errors: ["[ede_diagnostic] internal detail", "Tool execution failed: EACCES"],
      expected: "Tool execution failed: EACCES",
    },
    {
      name: "an HTTP 529 overload",
      isError: true,
      result: "API Error: 529 Specific overload detail.",
      apiErrorStatus: 529,
      expected: "Claude API is overloaded (529). Try again shortly.",
    },
    {
      name: "an HTTP 429 rate limit",
      isError: true,
      result: "API Error: 429 Specific rate limit detail.",
      apiErrorStatus: 429,
      expected: "Claude API rate limit reached. Try again later.",
    },
    {
      name: "a different terminal reason",
      isError: true,
      result: "API Error: 400 Request rejected.",
      terminalReason: "prompt_too_long" as const,
      expected:
        "Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.",
    },
  ])("reports terminal API error text for $name", (input) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-specific-api-error"),
          text: "Continue.",
          attachments: [],
        }),
      );
      const apiErrorStatus = input.apiErrorStatus ?? 400;
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000699",
          result: input.result,
          terminalReason: input.terminalReason ?? "api_error",
          apiErrorStatus,
          isError: input.isError,
          ...(input.errors === undefined ? {} : { errors: input.errors }),
        }),
      );

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.message, input.expected);
      assert.equal(terminal.failure.code, `api_error_${apiErrorStatus}`);
      assert.equal(
        terminal.failure.class,
        apiErrorStatus === 429 ? "usage_limit" : "provider_error",
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
  it.effect("names an expired Claude login instead of the terminal API error", () =>
    Effect.gen(function* () {
      const configDir = "/synthetic/Claude config";
      // The adapter resolves the cwd on the host, which adds a drive letter on Windows.
      const cwd = NodePath.resolve("/synthetic/project");
      const harness = yield* makeWakeHarnessWithOptions({
        environment: { CLAUDE_CONFIG_DIR: configDir },
      });
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-auth-failure"),
          text: "Continue.",
          attachments: [],
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd,
          }),
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000606",
          error: "authentication_failed",
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000607",
          result: "API Error: 401 Credentials expired.",
          terminalReason: "api_error",
        }),
      ]);

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.include(terminal.failure.message, "run `claude auth login`");
      assert.include(terminal.failure.message, configDir);
      assert.include(terminal.failure.message, JSON.stringify(cwd));
      assert.notInclude(terminal.failure.message, "repeated API errors");
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
  it.effect("shows a 403 permission error instead of the login hint", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-permission-denied"),
          text: "Continue.",
          attachments: [],
        }),
      );
      // Claude CLI 2.1.288 labels a 403 authentication_failed too.
      const cliText =
        "Failed to authenticate. API Error: 403 Your organization does not have access to this model.";
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000608",
          error: "authentication_failed",
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000609",
          result: cliText,
          isError: true,
          apiErrorStatus: 403,
          terminalReason: "api_error",
        }),
      ]);

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.message, cliText);
      assert.equal(terminal.failure.code, "api_error_403");
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
    { kind: "fork with inherited head", fork: true, headMessageId: "remapped-inherited-head" },
    { kind: "fork without recorded head", fork: true, headMessageId: undefined },
    { kind: "ordinary thread", fork: false, headMessageId: undefined },
  ])("rolls back the first run of a $kind", ({ fork, headMessageId }) =>
    Effect.gen(function* () {
      let allocations = 0;
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) => Queue.shutdown(sdkMessages),
        freshQueueOnReopen: true,
        allocateSessionId: Effect.sync(() =>
          allocations++ === 0 ? WAKE_NATIVE_SESSION : "fresh-native-session",
        ),
        forkSession: () =>
          Effect.succeed({
            sessionId: WAKE_NATIVE_SESSION,
            ...(headMessageId === undefined ? {} : { headMessageId }),
          }),
      });
      const providerThread = fork
        ? yield* harness.runtime.forkThread({
            sourceProviderThread: {
              ...harness.providerThread,
              nativeThreadRef: {
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeId: "source-native-session",
                strength: "strong",
              },
            },
            targetThreadId: harness.threadId,
          })
        : harness.providerThread;
      const turnInput = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("first-run"),
        text: "This run will be rolled back.",
        attachments: [],
        nativeThreadHasTurns: false,
      });
      yield* harness.runtime.startTurn(turnInput);
      yield* harness.offerAndWait(
        makeAssistantTextFrame({ uuid: "own-run-message", text: "Discard this answer." }),
      );
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: "own-run-result", result: "Discard this answer." }),
      );
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
      const completed = harness.events.findLast(
        (event) => event.type === "provider_thread.updated",
      );
      assert.equal(completed?.type, "provider_thread.updated");
      if (completed?.type !== "provider_thread.updated") return;
      assert.equal(completed.providerThread.firstRunOrdinal, 1);

      const rolledBack = yield* harness.runtime.rollbackThread({
        providerThread: completed.providerThread,
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-before-first-run"),
          appRunOrdinal: 0,
        },
        providerThreadTurns: [lastProviderTurn(harness.events)],
      });
      assert.equal(
        rolledBack.providerThread.forkedFrom?.providerThreadId,
        providerThread.forkedFrom?.providerThreadId,
      );
      yield* harness.runtime.startTurn({
        ...turnInput,
        attemptId: RunAttemptId.make("after-rollback"),
        providerThread: rolledBack.providerThread,
        providerTurnOrdinal: 2,
        nativeThreadHasTurns: false,
      });
      const options = harness.getOpenedOptions();
      assert.equal(harness.processQueues.length, 2);
      if (headMessageId !== undefined) {
        assert.equal(rolledBack.providerThread.nativeThreadRef?.nativeId, WAKE_NATIVE_SESSION);
        assert.equal(rolledBack.providerThread.nativeConversationHeadRef?.nativeId, headMessageId);
        assert.equal(options?.resume, WAKE_NATIVE_SESSION);
        assert.equal(options?.resumeSessionAt, headMessageId);
        assert.isUndefined(options?.sessionId);
      } else {
        assert.equal(rolledBack.providerThread.nativeThreadRef?.nativeId, "fresh-native-session");
        assert.isNull(rolledBack.providerThread.nativeConversationHeadRef);
        assert.equal(options?.sessionId, "fresh-native-session");
        assert.isUndefined(options?.resume);
        assert.isUndefined(options?.resumeSessionAt);
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
    "rolls back to the main-thread assistant message when a subagent frame comes last",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRollbackHarness;
        const now = yield* DateTime.now;
        const mainUuid = "00000000-0000-4000-8000-000000000641";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-cursor-main"),
            text: "Continue.",
            attachments: [],
          }),
        );
        yield* Queue.offerAll(harness.sdkMessages, [
          makeAssistantTextFrame({ uuid: mainUuid, text: "Delegating." }),
          makeAssistantErrorFrame({
            uuid: "00000000-0000-4000-8000-000000000642",
            error: undefined,
            parentToolUseId: "toolu_subagent",
          }),
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000643", result: "Done." }),
        ]);
        yield* Queue.take(harness.terminalReceipts);

        const providerTurn = lastProviderTurn(harness.events);
        assert.equal(providerTurn.nativeTurnRef?.nativeId, mainUuid);
        const rolledBack = yield* harness.runtime.rollbackThread({
          providerThread: harness.providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-claude-cursor-main"),
            appRunOrdinal: 1,
            providerTurn,
          },
          providerThreadTurns: [
            providerTurn,
            {
              ...providerTurn,
              id: ProviderTurnId.make("provider-turn-claude-cursor-next"),
              ordinal: 2,
            },
          ],
        });
        assert.equal(rolledBack.providerThread.nativeConversationHeadRef?.nativeId, mainUuid);
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
});
