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
  WAKE_NATIVE_SESSION,
  WAKE_TASK_ID,
  WAKE_ASSISTANT_TEXT,
  claudeSdkFrame,
  wakeTaskStarted,
  makeAssistantTextFrame,
  makeResultFrame,
  turnOneResult,
  wakeNotification,
  makeChangeSignal,
  yieldTicks,
  makeWakeHarnessWithOptions,
  providerThreadRosterEvents,
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
  it.effect.skipIf(process.getuid === undefined)(
    "tails foreground Bash output under the physical cwd the query launched in",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-task-output-cwd-",
          });
          const physicalCwd = path.join(root, "real", "project");
          const launchCwd = path.join(root, "link");
          yield* fileSystem.makeDirectory(physicalCwd, { recursive: true });
          yield* fileSystem.symlink(physicalCwd, launchCwd);
          // The session opens in /workspace; a relative TMPDIR puts Claude's
          // task files under whichever cwd the CLI was launched in. Linux,
          // because Claude Code's macOS build ignores TMPDIR.
          const harness = yield* makeWakeHarnessWithOptions({ environment: { TMPDIR: "../tmp" } });
          const now = yield* DateTime.now;
          const toolUseId = "toolu_foreground_bash";
          const taskId = "foreground-bash-task";
          const tasks = path.join(
            root,
            "real",
            "tmp",
            `claude-${process.getuid?.()}`,
            "project",
            WAKE_NATIVE_SESSION,
            "tasks",
          );
          yield* fileSystem.makeDirectory(tasks, { recursive: true });
          yield* fileSystem.writeFileString(path.join(tasks, `${taskId}.output`), "line 1\n");

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-task-output-cwd"),
              text: "Run the build.",
              attachments: [],
              runtimePolicy: { ...CLAUDE_TEST_RUNTIME_POLICY, cwd: launchCwd },
            }),
          );
          assert.equal(harness.getOpenedOptions()?.cwd, launchCwd);
          for (const frame of [
            claudeSdkFrame({
              type: "assistant",
              message: {
                model: "claude-sonnet-4-6",
                id: "msg_foreground_bash",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: toolUseId,
                    name: "Bash",
                    input: { command: "vp run build", description: "Build" },
                  },
                ],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              },
              parent_tool_use_id: null,
              uuid: "00000000-0000-4000-8000-000000000a01",
              session_id: WAKE_NATIVE_SESSION,
            }),
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskId,
              tool_use_id: toolUseId,
              description: "vp run build",
              is_backgrounded: false,
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000a02",
              session_id: WAKE_NATIVE_SESSION,
            }),
            claudeSdkFrame({
              type: "user",
              message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: toolUseId, content: "line 1" }],
              },
              parent_tool_use_id: null,
              uuid: "00000000-0000-4000-8000-000000000a03",
              session_id: WAKE_NATIVE_SESSION,
              tool_use_result: { stdout: "line 1\n", stderr: "", interrupted: false },
            }),
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000a04", result: "Built." }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitTerminal(1);

          const chunks = harness.events.flatMap((event) =>
            event.type === "command_output.delta" ? [event.chunk] : [],
          );
          assert.deepEqual(chunks, ["line 1\n"]);
        }).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
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
  it.effect("lets the native SDK acknowledge Stop before closing its own query", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closes = 0;
        let acknowledge = Effect.void;
        const harness = yield* makeWakeHarnessWithOptions({
          interrupt: Effect.suspend(() => {
            assert.equal(closes, 0);
            return acknowledge;
          }),
          close: (messages) =>
            Effect.sync(() => {
              closes++;
            }).pipe(Effect.andThen(Queue.shutdown(messages))),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("graceful-stop"),
            text: "Work until stopped",
            attachments: [],
          }),
        );
        acknowledge = harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000620",
            result: "",
            subtype: "error_during_execution",
            errors: ["Error: Request was aborted."],
            terminalReason: "aborted_streaming",
          }),
        );
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "running",
          ),
        );
        const active = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        if (active?.type !== "provider_turn.updated")
          return yield* Effect.die("Missing running native turn");
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: active.providerTurn.id,
          requestRuntimeRestart: true,
        });
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");
        assert.equal(closes, 1);
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
  it.effect("bounds an unacknowledged native Stop and settles its turn once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closes = 0;
        const interruptStarted = yield* Deferred.make<void>();
        const harness = yield* makeWakeHarnessWithOptions({
          interrupt: Deferred.succeed(interruptStarted, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          close: (messages) =>
            Effect.sync(() => {
              closes++;
            }).pipe(Effect.andThen(Queue.shutdown(messages))),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("unacknowledged-stop"),
            text: "Work until stopped",
            attachments: [],
          }),
        );
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "running",
          ),
        );
        const active = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        if (active?.type !== "provider_turn.updated")
          return yield* Effect.die("Missing running native turn");
        const stop = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: active.providerTurn.id,
            requestRuntimeRestart: true,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(interruptStarted);
        assert.equal(closes, 0);
        yield* TestClock.adjust("11 seconds");
        yield* Fiber.join(stop);
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");
        assert.equal(closes, 1);
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
  it.effect("preserves settled background work until an explicit stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closes = 0;
        const harness = yield* makeWakeHarnessWithOptions({
          close: (sdkMessages) =>
            Effect.sync(() => {
              closes++;
            }).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
        });
        const now = yield* DateTime.now;
        const attemptId = RunAttemptId.make("attempt-claude-settled-stop");
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId,
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);
        const settledThread = providerThreadRosterEvents(harness.events).at(-1)?.providerThread;
        assert.equal(settledThread?.pendingBackgroundTasks?.[0]?.taskId, WAKE_TASK_ID);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        const replacementAttempt = yield* harness.runtime
          .startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: {
                ...harness.providerThread,
                nativeThreadRef: {
                  ...harness.providerThread.nativeThreadRef!,
                  nativeId: "replacement-session",
                },
              },
              now,
              attemptId: RunAttemptId.make("attempt-claude-background-replacement"),
              text: "Continue in a fresh session.",
              attachments: [],
              providerTurnOrdinal: 2,
            }),
          )
          .pipe(Effect.result);
        assert.equal(replacementAttempt._tag, "Failure");
        assert.equal(closes, 0);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* harness.runtime.interruptTurn({
          providerThread: settledThread ?? harness.providerThread,
          providerTurnId: harness.terminalEvents()[0]!.providerTurnId,
          requestRuntimeRestart: true,
        });

        assert.equal(closes, 1, "Stop must close the CLI process that owns the task");
        yield* harness.until(
          () =>
            (providerThreadRosterEvents(harness.events).at(-1)?.providerThread
              .pendingBackgroundTasks?.length ?? 0) === 0,
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);
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
  it.effect("a settled Stop leaves a turn that replaced the closing process alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* makeChangeSignal;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-settled-stop-replaced-",
        });
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
        const firstCloseRequested = yield* Deferred.make<void>();
        const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
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
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }).pipe(Effect.andThen(changes.notify)),
          },
          queryRunner: {
            allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
            open: () =>
              Effect.gen(function* () {
                const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                const isFirstProcess = processQueues.length === 0;
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
                  close: isFirstProcess
                    ? Deferred.succeed(firstCloseRequested, undefined).pipe(Effect.asVoid)
                    : Queue.shutdown(sdkMessages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-settled-stop-replaced");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-settled-stop"),
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
          return yield* Effect.die("Claude adapter runtime must expose hasPendingBackgroundWork.");
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const terminals = () => events.filter((event) => event.type === "turn.terminal");
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-settled-stop-replaced-a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(processQueues[0]!, wakeTaskStarted);
        yield* Queue.offer(processQueues[0]!, turnOneResult);
        yield* changes.until(() => terminals().length === 1);
        const settledThread = providerThreadRosterEvents(events).at(-1)?.providerThread;
        const settledTurn = terminals()[0];
        assert.equal(settledThread?.pendingBackgroundTasks?.[0]?.taskId, WAKE_TASK_ID);

        const stop = yield* runtime
          .interruptTurn({
            providerThread: settledThread ?? providerThread,
            providerTurnId: settledTurn!.providerTurnId,
            requestRuntimeRestart: true,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(firstCloseRequested);

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread: { ...providerThread, status: "active" },
            now,
            attemptId: RunAttemptId.make("attempt-claude-settled-stop-replaced-b"),
            text: "Start another background build.",
            attachments: [],
            providerTurnOrdinal: 2,
            modelSelection: {
              ...CLAUDE_TEST_MODEL_SELECTION,
              model: "claude-haiku-4-5-20251001",
            },
          }),
        );
        assert.lengthOf(processQueues, 2);
        const replacementTaskId = "replacement-task";
        yield* Queue.offer(
          processQueues[1]!,
          claudeSdkFrame({
            ...wakeTaskStarted,
            task_id: replacementTaskId,
            uuid: "00000000-0000-4000-8000-000000000905",
          }),
        );
        yield* changes.until(
          () =>
            providerThreadRosterEvents(events).at(-1)?.providerThread.pendingBackgroundTasks?.[0]
              ?.taskId === replacementTaskId,
        );

        yield* Queue.shutdown(processQueues[0]!);
        yield* Fiber.join(stop);
        assert.isTrue(yield* hasPendingBackgroundWork);
        yield* yieldTicks(50);
        const latestThread = providerThreadRosterEvents(events).at(-1)?.providerThread;
        assert.equal(latestThread?.status, "active");
        assert.deepEqual(
          latestThread?.pendingBackgroundTasks?.map((task) => task.taskId),
          [replacementTaskId],
        );

        yield* Queue.offer(
          processQueues[1]!,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000906",
            result: "Started another build.",
          }),
        );
        yield* changes.until(() => terminals().length === 2);
        yield* Queue.offer(
          processQueues[1]!,
          claudeSdkFrame({
            ...wakeNotification,
            task_id: replacementTaskId,
            uuid: "00000000-0000-4000-8000-000000000907",
          }),
        );
        yield* Queue.offer(
          processQueues[1]!,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000908",
            text: WAKE_ASSISTANT_TEXT,
          }),
        );
        yield* changes.until(() => continuationRequests.length === 1);
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
