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
  CLAUDE_TEST_RESTART_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
  append,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  wakeTaskStarted,
  makeResultFrame,
  turnOneResult,
  makeChangeSignal,
  WORKFLOW_TOOL_USE_ID,
  makeWorkflowHarness,
  workflowToolUse,
  workflowTaskStarted,
  workflowLaunchAck,
  workflowSnapshot,
  workflowNotification,
  workflowCoordinatorEvents,
  workflowMemberEvents,
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
  it.effect("refuses a thinking change that would kill a running background subagent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* makeChangeSignal;
        const SUBAGENT_TASK_ID = "task-model-change-running-subagent";
        const SUBAGENT_TOOL_USE_ID = "toolu-model-change-running-subagent";
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-model-change-running-subagent-",
        });
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
        const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator,
          continuationRequests: { offer: () => Effect.void },
          queryRunner: {
            allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
            open: () =>
              Effect.gen(function* () {
                const sdkMessages = yield* Queue.unbounded<SDKMessage>();
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
                  close: Queue.shutdown(sdkMessages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-model-change-running-subagent");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-claude-model-change-running-subagent",
          ),
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
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-model-change-running-subagent-a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        const firstProcess = processQueues[0]!;
        yield* Queue.offer(
          firstProcess,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Background research",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Research, then report.",
            uuid: "00000000-0000-4000-8000-000000000901",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          firstProcess,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000902",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* changes.until(() => terminals().length === 1);
        const settledTurn = terminals()[0]!;

        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(providerThread));
        assert.isTrue(
          yield* runtime.hasPendingBackgroundWorkForThread!(providerThread, {
            includeSubagents: true,
          }),
        );
        assert.isFalse(
          yield* runtime.hasPendingBackgroundWorkForThread!(
            {
              ...providerThread,
              nativeThreadRef: {
                ...providerThread.nativeThreadRef!,
                nativeId: "sibling-native-session",
              },
            },
            { includeSubagents: true },
          ),
        );

        const alternateModel = CLAUDE_TEST_RESTART_MODEL_SELECTION;
        const switchTurn = (attempt: string) =>
          runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make(attempt),
              text: "Switch model while the subagent runs.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: alternateModel,
            }),
          );
        const refused = yield* switchTurn("attempt-claude-model-change-running-subagent-b").pipe(
          Effect.flip,
        );
        assert.equal(
          makeProviderFailure({ cause: refused, class: "provider_error" }).message,
          new ClaudeAdapterV2.ClaudeBackgroundWorkBlocksQueryReplacementError().message,
        );
        assert.lengthOf(processQueues, 1);

        yield* runtime.interruptTurn({
          providerThread,
          providerTurnId: settledTurn.providerTurnId,
          requestRuntimeRestart: true,
        });
        yield* switchTurn("attempt-claude-model-change-running-subagent-c");
        assert.lengthOf(processQueues, 2);

        yield* Queue.offer(
          processQueues[1]!,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000903",
            result: "Switched model.",
          }),
        );
        yield* changes.until(() => terminals().length === 2);
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread: { ...providerThread, status: "active" },
            now,
            attemptId: RunAttemptId.make("attempt-claude-model-change-running-subagent-d"),
            text: "Switch back.",
            attachments: [],
            providerTurnOrdinal: 3,
          }),
        );
        assert.lengthOf(processQueues, 3);
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

  // regression: #20413 an unreadable append file must not tear down the running process
  it.effect("keeps the live process when its replacement cannot read the append file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-append-replacement-",
        });
        const appendFile = NodePath.join(cwd, "rules.md");
        yield* fileSystem.writeFileString(appendFile, "File sentinel\n");
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
        let closes = 0;
        const firstTurnTerminal = yield* Deferred.make<void>();
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: {
            ...DEFAULT_CLAUDE_SETTINGS,
            launchArgs: "--append-system-prompt-file rules.md",
          },
          environment: {},
          attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-append-replacement-attachments-",
          }),
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
                  close: Effect.sync(() => {
                    closes += 1;
                  }).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        });
        const threadId = ThreadId.make("thread-claude-append-replacement");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-append-replacement"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.terminal"
              ? Deferred.succeed(firstTurnTerminal, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-append-replacement-a"),
            text: "What is the sentinel?",
            attachments: [],
            runtimePolicy,
          }),
        );
        yield* Queue.offer(
          processQueues[0]!,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000a01",
            result: "File sentinel",
          }),
        );
        yield* Deferred.await(firstTurnTerminal);

        yield* fileSystem.remove(appendFile);
        // A thinking change cannot apply live, so this turn must replace the process.
        const refused = yield* runtime
          .startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-append-replacement-b"),
              text: "Switch model.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: CLAUDE_TEST_RESTART_MODEL_SELECTION,
              runtimePolicy,
            }),
          )
          .pipe(Effect.flip);
        assert.equal(
          makeProviderFailure({ cause: refused, class: "provider_error" }).message,
          new ClaudeAdapterV2.ClaudeAppendSystemPromptFileError({ path: appendFile }).message,
        );
        assert.lengthOf(processQueues, 1);
        assert.equal(closes, 0);
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
  it.effect(
    "keeps the process and its roster when a model change meets a running background shell",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* makeChangeSignal;
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-replace-open-fail-",
          });
          let openCount = 0;
          const processQueues: Array<Queue.Queue<SDKMessage>> = [];
          const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            settings: DEFAULT_CLAUDE_SETTINGS,
            environment: {},
            attachmentsDir,
            fileSystem,
            path: yield* Path.Path,
            random: yield* SecureRandom.SecureRandom,
            idAllocator,
            continuationRequests: {
              offer: () => Effect.void,
            },
            queryRunner: {
              allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
              open: () => {
                openCount += 1;
                if (openCount === 2) {
                  return Effect.fail(
                    new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                      method: "open",
                      cause: "forced replacement open failure",
                    }),
                  );
                }
                return Effect.gen(function* () {
                  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
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
                    close: Queue.shutdown(sdkMessages),
                  };
                });
              },
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-replace-open-fail");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-claude-replace-open-fail"),
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
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const now = yield* DateTime.now;

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-a"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          yield* Queue.offer(processQueues[0]!, wakeTaskStarted);
          yield* Queue.offer(processQueues[0]!, turnOneResult);
          yield* changes.until(() => events.some((event) => event.type === "turn.terminal"));
          assert.isTrue(yield* hasPendingBackgroundWork);

          const alternateModel = CLAUDE_TEST_RESTART_MODEL_SELECTION;
          const failedStart = yield* runtime
            .startTurn(
              makeClaudeTestTurnInput({
                threadId,
                providerThread: { ...providerThread, status: "active" },
                now,
                attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-b"),
                text: "Replace process but fail open.",
                attachments: [],
                providerTurnOrdinal: 2,
                modelSelection: alternateModel,
              }),
            )
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(failedStart));
          assert.equal(openCount, 1);
          assert.isTrue(yield* hasPendingBackgroundWork);
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
  it.effect.each(["Agent", "Workflow"] as const)(
    "keeps a workflow running after its %s launch reply without an async flag",
    (toolName) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWorkflowHarness;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`attempt-workflow-launch-${toolName}`),
              text: "Run the workflow.",
              attachments: [],
            }),
          );
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...workflowToolUse,
              message: {
                model: "claude-sonnet-4-6",
                content: [
                  { type: "tool_use", id: WORKFLOW_TOOL_USE_ID, name: toolName, input: {} },
                ],
              },
            }),
          );
          yield* harness.offerAndWait(workflowTaskStarted);
          yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
          yield* harness.offerAndWait(
            workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001200", state: "start" }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001201", result: "Launched." }),
          );
          yield* Queue.take(harness.terminalReceipts);
          assert.equal(
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status,
            "running",
          );
          assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "running");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          const toolItems = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.nativeItemRef?.nativeId === WORKFLOW_TOOL_USE_ID
              ? [event.turnItem.status]
              : [],
          );
          assert.deepEqual(toolItems, toolName === "Workflow" ? ["running", "completed"] : []);
          yield* harness.offerAndWait(
            workflowNotification({
              uuid: "00000000-0000-4000-8000-000000001202",
              status: "completed",
            }),
          );
          yield* Queue.take(harness.continuationReceipts);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`attempt-workflow-complete-${toolName}`),
              text: "Workflow finished.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001205", result: "Finished." }),
          );
          yield* Queue.take(harness.terminalReceipts);
          assert.equal(
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status,
            "completed",
          );
          assert.equal(
            workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status,
            "completed",
          );
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
