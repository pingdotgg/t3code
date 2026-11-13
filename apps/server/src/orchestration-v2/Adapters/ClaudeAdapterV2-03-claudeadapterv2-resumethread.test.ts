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
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
  options,
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

describe("ClaudeAdapterV2 resumeThread", () => {
  it.effect("fails for a transcript without messages so a fresh session replaces it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-empty-session-",
        });
        const projectDir = path.join(configDir, "projects", "-workspace");
        yield* fileSystem.makeDirectory(projectDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(projectDir, "native-thread-empty.jsonl"),
          [
            `{"type":"last-prompt","lastPrompt":"hello","sessionId":"native-thread-empty"}`,
            `{"type":"atis-latch","atis":"","sessionId":"native-thread-empty"}`,
            `{"type":"cost-state","sessionId":"native-thread-empty","totalCostUSD":0}`,
            "",
          ].join("\n"),
        );
        yield* fileSystem.writeFileString(
          path.join(projectDir, "native-thread-saved.jsonl"),
          `{"type":"user","message":{"role":"user","content":"hello"},"sessionId":"native-thread-saved"}\n`,
        );
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: { CLAUDE_CONFIG_DIR: configDir },
          attachmentsDir: configDir,
          fileSystem,
          path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-empty"),
            open: () => Effect.die("unused"),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-empty-session");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-empty-session"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });

        const error = yield* Effect.flip(runtime.resumeThread({ providerThread }));
        assert.equal(error._tag, "ProviderAdapterResumeThreadError");

        const saved = yield* runtime.resumeThread({
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeId: "native-thread-saved",
              strength: "strong",
            },
          },
        });
        assert.equal(saved.nativeThreadRef?.nativeId, "native-thread-saved");

        const missing = yield* runtime.resumeThread({
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeId: "native-thread-missing",
              strength: "strong",
            },
          },
        });
        assert.equal(missing.nativeThreadRef?.nativeId, "native-thread-missing");
      }),
    ).pipe(
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
describe("ClaudeAdapterV2 resume compaction", () => {
  it.effect("resolves and cancels the SDK resume dialog through structured runtime input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-resume-",
        });
        let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-resume"),
            open: (input) =>
              Effect.sync(() => {
                openedOptions = input.options;
                return {
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-resume");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-resume"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-resume"),
            text: "continue",
            attachments: [],
          }),
        );
        const callback = openedOptions?.onUserDialog;
        assert.isFunction(callback);
        const canUseTool = openedOptions?.canUseTool;
        assert.isFunction(canUseTool);
        const shellSafetyReason =
          "Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed";
        for (const [safetyIndex, { askRule, reason }] of [
          { askRule: false, reason: shellSafetyReason },
          { askRule: true, reason: shellSafetyReason },
          {
            askRule: false,
            reason:
              "Dangerous rm operation on possibly-empty variable path: $TARGET\nUse a literal absolute path instead.",
          },
          { askRule: false, reason: "This shell -c script runs rm and could not be checked" },
          { askRule: false, reason: "A permission rule denies a command in this shell -c script" },
        ].entries()) {
          const safetyRequest = yield* runtime.events.pipe(
            Stream.filter((event) => event.type === "runtime_request.updated"),
            Stream.runHead,
            Effect.forkScoped,
          );
          const safetySignal = yield* Effect.abortSignal;
          const safetyDecision = yield* Effect.promise(() =>
            canUseTool!(
              "Bash",
              { command: "for pair in a b; do echo $pair; done" },
              {
                signal: safetySignal,
                toolUseID: `tool-shell-safety-${safetyIndex}`,
                requestId: `request-shell-safety-${safetyIndex}`,
                decisionReason: `\u001b[33m${reason}\u001b[39m`,
                suppressAlwaysAllowRule: true,
                ...(askRule
                  ? {
                      matchedAskRule: {
                        source: "userSettings" as const,
                        toolName: "Bash",
                        ruleContent: "*",
                      },
                    }
                  : {}),
              },
            ),
          ).pipe(Effect.forkScoped);
          const safety = yield* Effect.raceFirst(
            Fiber.join(safetyDecision).pipe(
              Effect.map((result) => ({ type: "decision", result }) as const),
            ),
            Fiber.join(safetyRequest).pipe(
              Effect.map((event) => ({ type: "approval", event }) as const),
            ),
          );
          assert.equal(safety.type, askRule ? "approval" : "decision");
          if (safety.type === "decision") {
            assert.equal(safety.result?.behavior, "deny");
            if (safety.result?.behavior === "deny") {
              assert.include(safety.result.message, reason);
              assert.notInclude(safety.result.message, "\u001b[");
            }
          } else if (
            Option.isSome(safety.event) &&
            safety.event.value.type === "runtime_request.updated"
          ) {
            yield* runtime.respondToRuntimeRequest({
              requestId: safety.event.value.runtimeRequest.id,
              decision: "decline",
            });
            assert.equal((yield* Fiber.join(safetyDecision))?.behavior, "deny");
          }
          yield* Fiber.interrupt(safetyRequest);
        }
        const longQuestion = `Choose a deployment target: ${"region ".repeat(80)}`;
        const questionRequestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const questionResult = yield* Effect.promise(() =>
          canUseTool!(
            "AskUserQuestion",
            {
              questions: [
                {
                  header: "Target",
                  question: longQuestion,
                  options: [
                    { label: "Production", description: "Deploy to production." },
                    { label: "Staging", description: "Deploy to staging." },
                  ],
                  multiSelect: true,
                },
              ],
            },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-question-full-access",
              requestId: "request-question-full-access",
            },
          ),
        ).pipe(Effect.forkScoped);
        const questionEvent = yield* Fiber.join(questionRequestEvent);
        assert.isTrue(Option.isSome(questionEvent));
        if (
          Option.isNone(questionEvent) ||
          questionEvent.value.type !== "runtime_request.updated"
        ) {
          return;
        }
        yield* runtime.respondToRuntimeRequest({
          requestId: questionEvent.value.runtimeRequest.id,
          answers: { [longQuestion]: ["Production", "Staging"] },
        });
        assert.deepEqual(yield* Fiber.join(questionResult), {
          behavior: "allow",
          updatedInput: {
            questions: [
              {
                header: "Target",
                question: longQuestion,
                options: [
                  { label: "Production", description: "Deploy to production." },
                  { label: "Staging", description: "Deploy to staging." },
                ],
                multiSelect: true,
              },
            ],
            answers: { [longQuestion]: "Production, Staging" },
          },
          toolUseID: "tool-question-full-access",
        });
        const longPlan = `# Deployment plan\n\n${"Validate every region before promotion.\n".repeat(120)}`;
        const proposedPlanEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "plan.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const exitPlanResult = yield* Effect.promise(() =>
          canUseTool!(
            "ExitPlanMode",
            { plan: longPlan },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-exit-plan-full-access",
              requestId: "request-exit-plan-full-access",
            },
          ),
        );
        assert.deepEqual(exitPlanResult, {
          behavior: "deny",
          message:
            "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          toolUseID: "tool-exit-plan-full-access",
        });
        const planEvent = yield* Fiber.join(proposedPlanEvent);
        assert.isTrue(Option.isSome(planEvent));
        if (Option.isSome(planEvent) && planEvent.value.type === "plan.updated") {
          assert.equal(planEvent.value.plan.kind, "proposed_plan");
          if (planEvent.value.plan.kind === "proposed_plan") {
            assert.equal(planEvent.value.plan.markdown, longPlan.trim());
          }
        }
        const requestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const signal = yield* Effect.abortSignal;
        const dialog = yield* Effect.promise(() =>
          callback!(
            {
              dialogKind: "resume_return",
              payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
            },
            { signal, requestId: "dialog-resume-1" },
          ),
        ).pipe(Effect.forkScoped);
        const event = yield* Fiber.join(requestEvent);
        assert.isTrue(Option.isSome(event));
        if (Option.isNone(event) || event.value.type !== "runtime_request.updated") return;
        const question = formatClaudeResumeCompactionQuestion({
          ageMinutes: 90,
          estimatedTokens: 120000,
        });
        yield* runtime.respondToRuntimeRequest({
          requestId: event.value.runtimeRequest.id,
          answers: { [question]: "Compact and continue" },
        });
        assert.deepEqual(yield* Fiber.join(dialog), { behavior: "completed", result: "compact" });

        assert.deepEqual(
          yield* Effect.promise(() =>
            callback!(
              {
                dialogKind: "resume_return",
                payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
              },
              { signal: AbortSignal.abort(), requestId: "dialog-resume-2" },
            ),
          ),
          { behavior: "cancelled" },
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
});
