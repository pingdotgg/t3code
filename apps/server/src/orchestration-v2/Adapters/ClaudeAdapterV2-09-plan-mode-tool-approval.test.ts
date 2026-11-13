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
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
  options,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeResultFrame,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
  openPlanTurn,
  requestWrite,
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
  describe("Plan-mode tool approval", () => {
    const openPlanTurn = Effect.fn("openPlanTurn")(function* (
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

    const requestWrite = Effect.fn("requestPlanWrite")(function* (
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

    it.effect.each([
      {
        runtimeMode: "auto",
        toolName: "Edit",
        toolInput: {
          file_path: "/workspace/target.txt",
          old_string: "before",
          new_string: "after",
        },
        kind: "file-change",
        decision: "accept",
        behavior: "allow",
      },
      {
        runtimeMode: "full-access",
        toolName: "Bash",
        toolInput: { command: "echo after > target.txt" },
        kind: "command",
        decision: "cancel",
        behavior: "deny",
      },
    ] as const)(
      "asks before $toolName in $runtimeMode Plan, then respects $decision",
      ({ runtimeMode, toolName, toolInput, kind, decision, behavior }) =>
        Effect.gen(function* () {
          const turn = yield* openPlanTurn(runtimeMode);
          const permission = yield* requestWrite(turn, toolName, toolInput);
          assert.equal(permission.first.type, "request", "the planned write bypassed approval");
          if (permission.first.type !== "request") return;
          const request = permission.first.event.runtimeRequest;
          assert.equal(request.status, "pending");
          assert.equal(request.kind, kind);
          yield* turn.runtime.respondToRuntimeRequest({ requestId: request.id, decision });
          const result = yield* Fiber.join(permission.decision);
          assert.equal(result?.behavior, behavior);
          if (result?.behavior === "allow") {
            assert.deepEqual(result.updatedInput, toolInput);
            assert.equal(result.toolUseID, "tool-plan-write");
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

    it.effect("denies Plan writes without asking when approvals are never allowed", () =>
      Effect.gen(function* () {
        const turn = yield* openPlanTurn("full-access", "never");
        const permission = yield* requestWrite(turn, "Bash", {
          command: "echo after > target.txt",
        });
        assert.equal(permission.first.type, "decision", "Never raised an approval request");
        if (permission.first.type !== "decision") return;
        assert.equal(permission.first.result?.behavior, "deny");
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
      "returns approval feedback to the requesting tool without sending a parent prompt",
      () =>
        Effect.gen(function* () {
          const turn = yield* openPlanTurn("full-access");
          const parentPermission = yield* requestWrite(
            turn,
            "Bash",
            { command: "git status" },
            { toolUseID: "parent-command" },
          );
          assert.equal(parentPermission.first.type, "request");
          if (parentPermission.first.type !== "request") return;
          const permission = yield* requestWrite(
            turn,
            "Bash",
            { command: "rm -f $W/*/*.obj" },
            { toolUseID: "child-command", agentID: "child-worker" },
          );
          assert.equal(permission.first.type, "request");
          if (permission.first.type !== "request") return;
          const request = permission.first.event.runtimeRequest;
          assert.equal(request.responseCapability.type, "live");
          assert.isTrue(
            request.responseCapability.type === "live" &&
              request.responseCapability.supportsFeedback,
          );
          yield* turn.runtime.respondToRuntimeRequest({
            requestId: request.id,
            decision: "decline",
            feedback: "Run it in a safer manner.",
          });
          const result = yield* Fiber.join(permission.decision);
          assert.equal(result?.behavior, "deny");
          if (result?.behavior === "deny") {
            assert.include(result.message, "Run it in a safer manner.");
            assert.notProperty(result, "interrupt");
          }
          assert.equal(turn.offeredMessages.length, 1);
          yield* turn.runtime.respondToRuntimeRequest({
            requestId: parentPermission.first.event.runtimeRequest.id,
            decision: "accept",
          });
          const parentResult = yield* Fiber.join(parentPermission.decision);
          assert.equal(parentResult?.behavior, "allow");
          if (parentResult?.behavior === "allow")
            assert.equal(parentResult.toolUseID, "parent-command");
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

    it.effect("still captures ExitPlanMode when Plan approvals are never allowed", () =>
      Effect.gen(function* () {
        const turn = yield* openPlanTurn("full-access", "never");
        const markdown = "# Proposed work\n\nFix the calculation after approval.";
        const result = yield* Effect.promise(() =>
          turn.canUseTool(
            "ExitPlanMode",
            { plan: markdown },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-plan-capture",
              requestId: "request-plan-capture",
            },
          ),
        );
        assert.equal(result?.behavior, "deny");
        if (result?.behavior === "deny")
          assert.include(result.message, "captured your proposed plan");
        const event = yield* Queue.take(turn.planReceipts);
        assert.equal(event.plan.kind, "proposed_plan");
        assert.equal(event.plan.kind === "proposed_plan" ? event.plan.markdown : "", markdown);
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
  it.effect(
    "carries earlier user-only skill instructions on sends and steering with attachments",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skill-dispatch-" });
        for (const [name, userOnly] of [
          ["interrogate", true],
          ["implement", true],
          ["review", false],
        ] as const) {
          const directory = path.join(homePath, "skills", name);
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.writeFileString(
            path.join(directory, "SKILL.md"),
            `---\nname: ${name}\ndisable-model-invocation: ${userOnly}\n---\nFollow the ${name} instructions.\n`,
          );
        }
        const harness = yield* makeWakeHarnessWithOptions({
          settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath },
        });
        const input = makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("skill-dispatch"),
          text: "$interrogate then $review then $implement the fixes",
          attachments: [],
          runtimePolicy: { ...CLAUDE_TEST_RUNTIME_POLICY, cwd: homePath },
        });
        yield* harness.runtime.startTurn(input);

        const leadingText = `Ultrathink:\n/interrogate [The user invoked this skill. Follow the instructions at: ${path.join(homePath, "skills", "interrogate", "SKILL.md")}] then /review then /implement the fixes`;
        assert.deepEqual(harness.offeredMessages[0]?.message.content, [
          { type: "text", text: leadingText },
          { type: "text", text: "/implement the fixes" },
        ]);

        const attachment = ChatFileAttachment.make({
          type: "file",
          id: ChatAttachmentId.make("skill-dispatch-12345678-1234-1234-1234-123456789abc"),
          name: "requirements.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
        });
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        yield* harness.runtime.steerTurn({
          threadId: harness.threadId,
          runId: input.runId,
          providerThread: harness.providerThread,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${input.attemptId}`,
          }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("skill-dispatch-steer"),
            text: input.message.text,
            attachments: [attachment],
          },
        });
        const attachmentNote = `\n\n[Attached file "requirements.pdf" is saved at: ${path.join(harness.attachmentsDir, attachmentRelativePath(attachment)!)}]`;
        assert.equal(harness.offeredMessages[1]?.priority, "now");
        assert.deepEqual(harness.offeredMessages[1]?.message.content, [
          { type: "text", text: `${leadingText}${attachmentNote}` },
          { type: "text", text: `/implement the fixes${attachmentNote}` },
        ]);
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

  // regression: #15475 MCP title arriving after the tool starts must survive to completion
  it.effect.each([
    { isError: false, title: "Check weather" },
    { isError: true, title: "Check weather" },
    { isError: false, title: undefined },
  ])("keeps late MCP display metadata with %j", ({ isError, title }) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("mcp-presentation"),
          text: "Check the weather",
          attachments: [],
        }),
      );
      const toolName = "mcp__weather__get_weather";
      const id = "weather-call";
      const permission = yield* Effect.promise(() =>
        harness.getOpenedOptions()!.canUseTool!(
          toolName,
          { city: "Berlin" },
          {
            signal: new AbortController().signal,
            toolUseID: id,
            requestId: "weather-request",
          },
        ),
      ).pipe(Effect.forkScoped);
      const request = yield* Queue.take(harness.runtimeRequestReceipts);
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: request.runtimeRequest.id,
        decision: "accept",
      });
      yield* Fiber.join(permission);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "assistant",
          uuid: "weather-assistant",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            id: "weather-message",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "tool_use", id, name: toolName, input: { city: "Berlin" } }],
          },
          tool_use_meta: [
            {
              id,
              display_name: title,
              server_display_name: "Weather",
              icon_url: "https://example.com/weather.png",
            },
          ],
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "user",
          uuid: "weather-result",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: "Weather result",
                is_error: isError,
              },
            ],
          },
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({ uuid: "weather-terminal", result: "Weather checked" }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const items = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        items.map((item) => item.status),
        ["running", "running", isError ? "failed" : "completed"],
      );
      assert.isNull(items[0]?.title);
      for (const item of items.slice(1)) {
        assert.equal(item.title, title ?? "get weather");
        assert.deepEqual(item.toolIcon, {
          _tag: "themed-logo",
          logoUrl: "https://example.com/weather.png",
        });
        assert.deepEqual(item.toolSource, {
          key: "mcp:weather",
          name: "Weather",
          kind: "integration",
          icon: { _tag: "themed-logo", logoUrl: "https://example.com/weather.png" },
        });
        assert.deepEqual(item.input, { city: "Berlin" });
      }
      assert.equal(new Set(items.map((item) => item.id)).size, 1);
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
      content: { type: "advisor_tool_result_error", error_code: "overloaded" },
      status: "failed",
    },
    { content: { type: "advisor_result", text: "Looks right." }, status: "completed" },
  ] as const)("settles an advisor call from its result content: $status", ({ content, status }) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("advisor-result"),
          text: "Check the plan with the advisor",
          attachments: [],
        }),
      );
      const id = "srvtoolu_advisor";
      const assistantFrame = (uuid: string, block: unknown) =>
        claudeSdkFrame({
          type: "assistant",
          uuid,
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            id: "advisor-message",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [block],
          },
        });
      yield* harness.offerAndWait(
        assistantFrame("advisor-call", { type: "server_tool_use", id, name: "advisor", input: {} }),
      );
      yield* harness.offerAndWait(
        assistantFrame("advisor-result", { type: "advisor_tool_result", tool_use_id: id, content }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({ uuid: "advisor-terminal", result: "Checked" }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const items = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem]
          : [],
      );
      assert.equal(items.at(-1)?.toolName, "advisor");
      assert.equal(items.at(-1)?.status, status);
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
