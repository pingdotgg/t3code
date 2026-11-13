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
  makeFakeClaudeCli,
  t3McpServer,
  openWith,
  openTurnWithOrdinal,
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

describe("ClaudeAdapterV2 native fork", () => {
  it.effect("forks at the source assistant cursor and resumes the forked session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-fork-attachments-",
        });
        const openedQueries: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const forkCalls: Array<ClaudeAdapterV2.ClaudeAgentSdkSessionForkInput> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: { CLAUDE_CONFIG_DIR: "/custom/claude-home" },
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("source-native-session"),
            open: (input) =>
              Effect.sync(() => {
                openedQueries.push(input);
                return {
                  messages: Stream.empty,
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
            forkSession: (input) =>
              Effect.sync(() => {
                forkCalls.push(input);
                return { sessionId: "forked-native-session" };
              }),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const providerSessionId = ProviderSessionId.make("provider-session-claude-fork");
        const sourceThreadId = ThreadId.make("thread-claude-fork-source");
        const targetThreadId = ThreadId.make("thread-claude-fork-target");
        const runtime = yield* adapter.openSession({
          threadId: sourceThreadId,
          providerSessionId,
          modelSelection: {
            instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });
        const sourceProviderThread = yield* runtime.ensureThread({
          threadId: sourceThreadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });
        const now = yield* DateTime.now;
        const providerTurnId = ProviderTurnId.make("provider-turn-claude-source");
        const forkedProviderThread = yield* runtime.forkThread({
          sourceProviderThread,
          sourceProviderTurns: [
            {
              id: providerTurnId,
              providerThreadId: sourceProviderThread.id,
              nodeId: NodeId.make("node-claude-source"),
              runAttemptId: RunAttemptId.make("run-attempt-claude-source"),
              nativeTurnRef: {
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeId: "assistant-message-cursor",
                strength: "weak",
              },
              ordinal: 1,
              status: "completed",
              startedAt: now,
              completedAt: now,
            },
          ],
          providerTurnId,
          targetThreadId,
        });

        assert.deepEqual(forkCalls, [
          {
            sessionId: "source-native-session",
            options: {
              dir: "/workspace",
              upToMessageId: "assistant-message-cursor",
            },
            environment: { CLAUDE_CONFIG_DIR: "/custom/claude-home" },
            threadId: targetThreadId,
            providerSessionId,
          },
        ]);
        assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, "forked-native-session");
        assert.equal(forkedProviderThread.forkedFrom?.providerThreadId, sourceProviderThread.id);
        assert.equal(forkedProviderThread.forkedFrom?.providerTurnId, providerTurnId);

        yield* runtime.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: targetThreadId,
            projectId: ProjectId.make("project-claude-fork-target"),
            title: "Claude fork target",
            providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            modelSelection: {
              instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
              model: "claude-sonnet-4-6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: forkedProviderThread.id,
            lineage: {
              parentThreadId: sourceThreadId,
              relationshipToParent: "fork",
              rootThreadId: sourceThreadId,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId: targetThreadId,
          runId: RunId.make("run-claude-fork-target"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("run-attempt-claude-fork-target"),
          rootNodeId: NodeId.make("node-claude-fork-target-root"),
          providerThread: forkedProviderThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-claude-fork-target"),
            text: "Respond with fork ok",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });

        assert.equal(openedQueries[0]?.options.resume, "forked-native-session");
        assert.equal(openedQueries[0]?.options.sessionId, undefined);
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
describe("ClaudeAdapterV2 MCP credential channel", () => {
  const t3McpServer = {
    type: "http" as const,
    url: "http://127.0.0.1:43123/mcp",
    headers: { Authorization: "Bearer dummy-mcp-credential" },
  };
  const openWith = (
    cli: ReturnType<typeof makeFakeClaudeCli>,
    native?: ProviderEventLoggers.EventNdjsonLogger,
  ) =>
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      return yield* runner.open({
        threadId: ThreadId.make("thread-claude-mcp-channel"),
        providerSessionId: ProviderSessionId.make("provider-session-claude-mcp-channel"),
        options: {
          ...ClaudeAdapterV2.makeClaudeQueryOptions({
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            nativeThreadId: "native-thread-claude-mcp-channel",
            title: "Existing T3 title",
            resume: false,
            cwd: null,
            environment: { PATH: "/usr/bin" },
            mcpServers: { "t3-code": t3McpServer },
          }),
          pathToClaudeCodeExecutable: "/opt/claude/cli.js",
          spawnClaudeCodeProcess: cli.spawn,
        },
      });
    }).pipe(
      Effect.provide(ClaudeAdapterV2.layerQueryRunner.pipe(Layer.provide(PortScanner.layerTest))),
      Effect.provideService(ProviderEventLoggers.ProviderEventLoggers, {
        ...ProviderEventLoggers.NoOpProviderEventLoggers,
        native,
      }),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );

  it.effect("commits queued delivery before interruptible protocol logging", () =>
    Effect.gen(function* () {
      const logging = yield* Deferred.make<void>();
      let committed = false;
      const cli = makeFakeClaudeCli();
      const session = yield* openWith(cli, {
        filePath: "/tmp/claude-queued-delivery.log",
        write: () =>
          committed
            ? Deferred.succeed(logging, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        close: () => Effect.void,
      });
      const offering = yield* session
        .offer(ClaudeAdapterV2.makeClaudeUserMessage({ text: "Inspect the attachment." }), () => {
          committed = true;
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(logging);
      yield* Fiber.interrupt(offering);
      assert.isTrue(committed);
      committed = false;
      yield* session.close;
    }),
  );

  it.effect("sends MCP servers over stdin, not argv or the environment", () =>
    Effect.gen(function* () {
      const cli = makeFakeClaudeCli();
      const session = yield* openWith(cli);
      yield* session.close;

      assert.deepInclude(cli.controlRequests, {
        subtype: "mcp_set_servers",
        servers: { "t3-code": t3McpServer },
      });
      assert.deepInclude(
        cli.controlRequests.find((request) => Reflect.get(request, "subtype") === "initialize"),
        { title: "Existing T3 title" },
      );
      const spawned = JSON.stringify(cli.spawns);
      assert.notInclude(spawned, "--title");
      assert.notInclude(spawned, "--mcp-config");
      assert.notInclude(spawned, "dummy-mcp-credential");
    }),
  );
});
describe("ClaudeAdapterV2 native session identity", () => {
  const openTurnWithOrdinal = (
    providerTurnOrdinal: number,
    nativeThreadHasTurns?: boolean,
    importedNativeThreadId?: string,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-session-identity-",
        });
        if (importedNativeThreadId !== undefined) {
          // An unreadable copy in another project must not hide the readable one.
          yield* fileSystem.makeDirectory(
            path.join(attachmentsDir, "projects", "-other", `${importedNativeThreadId}.jsonl`),
            { recursive: true },
          );
          const projectDir = path.join(attachmentsDir, "projects", "-workspace");
          yield* fileSystem.makeDirectory(projectDir, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(projectDir, `${importedNativeThreadId}.jsonl`),
            `{"type":"user","message":{"role":"user","content":"hello"},"sessionId":"${importedNativeThreadId}"}\n`,
          );
        }
        const openedQueries: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: { CLAUDE_CONFIG_DIR: attachmentsDir },
          attachmentsDir,
          fileSystem,
          path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-session-identity"),
            open: (input) =>
              Effect.sync(() => {
                openedQueries.push(input);
                return {
                  messages: Stream.empty,
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
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-session-identity");
        const providerSessionId = ProviderSessionId.make("provider-session-claude-identity");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const now = yield* DateTime.now;
        // Mirrors the provider thread a session import records: a strong native
        // ref with no conversation head and no provider turns.
        const providerThread =
          importedNativeThreadId === undefined
            ? yield* runtime.ensureThread({
                threadId,
                modelSelection: CLAUDE_TEST_MODEL_SELECTION,
                runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
              })
            : yield* runtime.resumeThread({
                threadId,
                modelSelection: CLAUDE_TEST_MODEL_SELECTION,
                runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
                providerThread: {
                  id: idAllocator.derive.providerThread({
                    driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                    providerInstanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
                    nativeThreadId: importedNativeThreadId,
                  }),
                  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                  providerInstanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
                  providerSessionId: null,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                    nativeId: importedNativeThreadId,
                    strength: "strong",
                  },
                  nativeConversationHeadRef: null,
                  status: "not_loaded",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  contextUsage: null,
                  nativeMetadata: null,
                  goal: null,
                  createdAt: now,
                  updatedAt: now,
                },
              });
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("run-attempt-claude-session-identity"),
            text: "Respond with identity ok",
            attachments: [],
            providerTurnOrdinal,
            ...(nativeThreadHasTurns === undefined ? {} : { nativeThreadHasTurns }),
          }),
        );
        return openedQueries;
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
    "resumes the native session on a fresh session instance when prior provider turns exist",
    () =>
      Effect.gen(function* () {
        const openedQueries = yield* openTurnWithOrdinal(2);
        assert.equal(openedQueries.length, 1);
        assert.equal(openedQueries[0]?.options.resume, "native-session-identity");
        assert.equal(openedQueries[0]?.options.sessionId, undefined);
        assert.equal(openedQueries[0]?.options.title, "Claude attachment test");
      }),
  );

  it.effect("creates a fresh native session despite earlier provider-thread turns", () =>
    Effect.gen(function* () {
      const openedQueries = yield* openTurnWithOrdinal(4, false);
      assert.equal(openedQueries[0]?.options.sessionId, "native-session-identity");
      assert.equal(openedQueries[0]?.options.resume, undefined);
      assert.equal(openedQueries[0]?.options.title, "Claude attachment test");
    }),
  );

  it.effect("resumes an imported native session on its first T3 turn", () =>
    Effect.gen(function* () {
      const openedQueries = yield* openTurnWithOrdinal(1, false, "imported-native-session");
      assert.equal(openedQueries.length, 1);
      assert.equal(openedQueries[0]?.options.resume, "imported-native-session");
      assert.equal(openedQueries[0]?.options.sessionId, undefined);
    }),
  );
});
