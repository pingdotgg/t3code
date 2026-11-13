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
  makeAssistantTextFrame,
  makeResultFrame,
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
  it.effect.each([
    {
      case: "an Edit",
      toolName: "Edit",
      toolInput: {
        file_path: "/workspace/src/math.ts",
        old_string: "  return a - b;",
        new_string: "  return a + b;",
      },
      toolUseResult: {
        filePath: "/workspace/src/math.ts",
        oldString: "  return a - b;",
        newString: "  return a + b;",
        originalFile: "export function add(a: number, b: number) {\n  return a - b;\n}\n",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 3,
            lines: [
              " export function add(a: number, b: number) {",
              "-  return a - b;",
              "+  return a + b;",
              " }",
            ],
          },
        ],
        userModified: false,
        replaceAll: false,
      },
      diffStr:
        "--- /workspace/src/math.ts\n+++ /workspace/src/math.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number) {\n-  return a - b;\n+  return a + b;\n }\n",
    },
    {
      case: "a Write that creates a file",
      toolName: "Write",
      toolInput: { file_path: "/workspace/notes.md", content: "# Notes\n\nShip it.\n" },
      toolUseResult: {
        type: "create",
        filePath: "/workspace/notes.md",
        content: "# Notes\n\nShip it.\n",
        structuredPatch: [],
        originalFile: null,
        userModified: false,
      },
      diffStr: "--- /dev/null\n+++ /workspace/notes.md\n@@ -0,0 +1,3 @@\n+# Notes\n+\n+Ship it.\n",
    },
    {
      case: "a Write that creates an empty file",
      toolName: "Write",
      toolInput: { file_path: "/workspace/.keep", content: "" },
      toolUseResult: {
        type: "create",
        filePath: "/workspace/.keep",
        content: "",
        structuredPatch: [],
        originalFile: null,
        userModified: false,
      },
      diffStr: undefined,
    },
  ])("stores the diff panel patch for $case", (testCase) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const toolUseId = `toolu_01${testCase.toolName}Patch`;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`attempt-claude-${testCase.toolName}-patch`),
            text: "Change it.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: `msg_${testCase.toolName}_patch`,
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: toolUseId,
                  name: testCase.toolName,
                  input: testCase.toolInput,
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000793",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: `The file ${testCase.toolInput.file_path} has been updated successfully.`,
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000794",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: testCase.toolUseResult,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000795", result: "Done." }),
        );
        yield* harness.awaitTerminal(1);

        const fileChange = harness.events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === toolUseId,
        );
        assert.deepEqual(
          fileChange?.type === "turn_item.updated" && fileChange.turnItem.type === "file_change"
            ? { diffStr: fileChange.turnItem.diffStr }
            : undefined,
          { diffStr: testCase.diffStr },
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
  it.effect("answers an approval a held wake turn raises without waiting for the echo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const approvalPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const firstAttempt = RunAttemptId.make("attempt-claude-wake-approval-1");
        const userAttempt = RunAttemptId.make("attempt-claude-wake-approval-2");
        const bashToolUseId = "toolu_01WakeApprovalBash";
        const stamp = (frame: SDKMessage, promptIndex: number) =>
          claudeSdkFrame({
            ...frame,
            user_message_uuid: harness.promptUuid(promptIndex),
          });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: firstAttempt,
            text: "First.",
            attachments: [],
            runtimePolicy: approvalPolicy,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000780", text: "One." }),
            0,
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000781", result: "One." }),
            0,
          ),
        );
        yield* harness.awaitTerminal(1);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: userAttempt,
            text: "Second.",
            attachments: [],
            providerTurnOrdinal: 2,
            runtimePolicy: approvalPolicy,
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_wake_bash",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: bashToolUseId,
                  name: "Bash",
                  input: { command: "git status" },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000782",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const permission = yield* Effect.promise(() =>
          harness.getOpenedOptions()!.canUseTool!(
            "Bash",
            { command: "git status" },
            {
              signal: new AbortController().signal,
              toolUseID: bashToolUseId,
              requestId: "request-wake-bash",
            },
          ),
        ).pipe(Effect.forkScoped);

        yield* harness.until(() =>
          harness.events.some((event) => event.type === "runtime_request.updated"),
        );
        const request = harness.events.findLast(
          (event) => event.type === "runtime_request.updated",
        );
        const bashItems = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === bashToolUseId
            ? [event.turnItem.runId]
            : [],
        );
        assert.isNotEmpty(bashItems);
        assert.isTrue(bashItems.every((runId) => runId === RunId.make(`run-${userAttempt}`)));
        if (request?.type !== "runtime_request.updated") return;
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: request.runtimeRequest.id,
          decision: "accept",
        });
        const result = yield* Fiber.join(permission);
        assert.equal(result?.behavior, "allow");
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
  it.effect.each([
    { card: "an approval", toolName: "Bash", toolInput: { command: "echo probe" } },
    {
      card: "a question",
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [
          {
            header: "Target",
            question: "Where should this deploy?",
            options: [
              { label: "Production", description: "Deploy to production." },
              { label: "Staging", description: "Deploy to staging." },
            ],
            multiSelect: false,
          },
        ],
      },
    },
  ])("closes $card card when Claude withdraws its request", ({ toolName, toolInput }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-withdrawn-approval"),
            text: "Run the probe.",
            attachments: [],
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: "/workspace",
            }),
          }),
        );
        // The CLI cancels a request once a PermissionRequest hook has answered it.
        // @effect-diagnostics-next-line abortControllerInEffect:off - Claude, not the test fiber, withdraws the request.
        const withdrawal = new AbortController();
        const permission = yield* Effect.promise(() =>
          harness.getOpenedOptions()!.canUseTool!(toolName, toolInput, {
            signal: withdrawal.signal,
            toolUseID: "toolu_01WithdrawnApproval",
            requestId: "request-withdrawn-approval",
          }),
        ).pipe(Effect.forkScoped);
        const pending = (yield* Queue.take(harness.runtimeRequestReceipts)).runtimeRequest;
        assert.equal(pending.status, "pending");

        // The turn can end right after the withdrawal, before the callback returns.
        withdrawal.abort();
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000790", result: "Done." }),
            user_message_uuid: harness.promptUuid(0),
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal((yield* Fiber.join(permission))?.behavior, "deny");
        // The cancellation has to land before the turn's end finalizes the run.
        const beforeTerminal = harness.events.slice(
          0,
          harness.events.findIndex((event) => event.type === "turn.terminal"),
        );
        const statusOf = (type: "runtime_request.updated" | "node.updated" | "turn_item.updated") =>
          beforeTerminal
            .flatMap((event): Array<{ readonly type: string; readonly status: string }> =>
              event.type === "runtime_request.updated" && event.runtimeRequest.id === pending.id
                ? [{ type: event.type, status: event.runtimeRequest.status }]
                : event.type === "node.updated" && event.node.id === pending.nodeId
                  ? [{ type: event.type, status: event.node.status }]
                  : event.type === "turn_item.updated" && event.turnItem.nodeId === pending.nodeId
                    ? [{ type: event.type, status: event.turnItem.status }]
                    : [],
            )
            .findLast((entry) => entry.type === type)?.status;
        assert.equal(statusOf("runtime_request.updated"), "cancelled");
        assert.equal(statusOf("node.updated"), "cancelled");
        assert.equal(statusOf("turn_item.updated"), "cancelled");
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
  it.effect("releases output held for a prompt echo when the stream ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarnessWithOptions({
          close: (sdkMessages) => Queue.shutdown(sdkMessages),
        });
        const now = yield* DateTime.now;
        const firstAttempt = RunAttemptId.make("attempt-claude-echo-1");
        const secondAttempt = RunAttemptId.make("attempt-claude-echo-2");
        const stamp = (frame: SDKMessage, promptIndex: number) =>
          claudeSdkFrame({
            ...frame,
            user_message_uuid: harness.promptUuid(promptIndex),
          });
        const assistantTexts = () =>
          harness.events.flatMap((event) =>
            event.type === "message.updated" && event.message.role === "assistant"
              ? [event.message.text]
              : [],
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: firstAttempt,
            text: "First.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000701", text: "One." }),
            0,
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          stamp(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000702", result: "One." }),
            0,
          ),
        );
        yield* harness.awaitTerminal(1);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: secondAttempt,
            text: "Second.",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* harness.offerAndWait(
          makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000703", text: "Two." }),
        );
        assert.deepEqual(assistantTexts(), ["One."]);

        yield* Queue.shutdown(harness.sdkMessages);
        yield* harness.awaitTerminal(2);
        assert.deepEqual(assistantTexts(), ["One.", "Two."]);
        assert.equal(harness.terminalEvents()[1]?.status, "failed");
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
  it.effect("fails a prompt Claude completes without starting a turn for it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Claude answers previously recorded prompt uuids with only a completed lifecycle frame.
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-duplicate-prompt"),
            text: "Bump this PR to the latest main.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "command_lifecycle",
            command_uuid: harness.promptUuid(0),
            state: "completed",
            uuid: "00000000-0000-4000-8000-000000000790",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.awaitTerminal(1);
        const [terminal] = harness.terminalEvents();
        assert.equal(terminal?.status, "failed");
        if (terminal?.status !== "failed") return;
        assert.equal(terminal.threadDisposition, "reusable");
        assert.include(terminal.failure.message, "never started a turn");
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

  // regression: #17531 a mod that holds a tool behind a focused pane must fail the turn, not hang it
  it.effect.each([
    { case: "fails a turn whose mod requests focus for a pane T3 cannot show", focus: true },
    { case: "keeps a turn running beside a passive mod pane", focus: false },
  ] as const)("$case", ({ focus }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const closed = yield* Deferred.make<void>();
        const harness = yield* makeWakeHarnessWithOptions({
          close: () => Deferred.succeed(closed, undefined),
        });
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-mod-pane-focus"),
            text: "Run rm -r build",
            attachments: [],
          }),
        );
        // Captured from Claude 2.1.303 with the blast-radius mod holding a Bash
        // call: the mod waits for keyboard input in its pane and nothing else
        // arrives until it gives up.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "ui_panes",
            panes: [
              { id: "blast-radius", title: "Blast Radius", plugin: "blast-radius", rows: 10 },
            ],
            shown_id: "blast-radius",
            focused_id: null,
            focus_requested_id: focus ? "blast-radius" : null,
            uuid: "00000000-0000-4000-8000-000000000795",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "ui_invalidate",
            event: "ui.render",
            uuid: "00000000-0000-4000-8000-000000000796",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        // Frames are handled in order, so a later notice proves the pane frame
        // was handled without the turn ending.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "informational",
            content: "Processing barrier.",
            level: "warning",
            uuid: "00000000-0000-4000-8000-000000000797",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.until(
          () =>
            harness.terminalEvents().length > 0 ||
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
            ),
        );
        const [terminal] = harness.terminalEvents();
        if (!focus) {
          assert.equal(terminal, undefined);
          return;
        }
        assert.equal(terminal?.status, "failed");
        if (terminal?.status !== "failed") return;
        assert.include(terminal.failure.message, "blast-radius");
        // The held tool call is abandoned by closing the query, never answered.
        yield* Deferred.await(closed);
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

  // regression: #17531 a follow-up sent while the failed mod turn's process closes gets a new process
});
