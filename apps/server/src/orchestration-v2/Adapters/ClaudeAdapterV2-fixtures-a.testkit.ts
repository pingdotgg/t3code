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
export const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

export const AUTO_COMPACT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({
  autoCompactWindow: "300000",
});

export const CUSTOM_MODEL_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({
  customModels: [
    "opus",
    {
      slug: "claude-custom-tuned",
      name: "Tuned",
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "gentle", label: "Gentle", isDefault: true },
              { id: "brutal", label: "Brutal" },
            ],
          },
        ],
      },
    },
  ],
});

export const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;

export const CLAUDE_TEST_RESTART_MODEL_SELECTION = {
  ...CLAUDE_TEST_MODEL_SELECTION,
  model: "claude-haiku-4-5-20251001",
  options: [{ id: "thinking", value: false }],
} satisfies ModelSelection;

export const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

export function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Claude attachment test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly messageCreatedBy?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["createdBy"];
  readonly messageCreationSource?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["creationSource"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    ...(input.nativeThreadHasTurns === undefined
      ? {}
      : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: input.attachments,
    },
    modelSelection: input.modelSelection ?? CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: input.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY,
  };
}

export const T3_MCP_SERVERS = {
  "t3-code": {
    type: "http",
    url: "http://127.0.0.1:43123/mcp",
    headers: {
      Authorization: "Bearer secret-claude-token",
    },
    timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
  },
} as const;

export const mcpSessionFor = (
  threadId: ThreadId,
  authorizationHeader = "Bearer secret-claude-token",
): McpProviderSession.McpProviderSessionConfig => ({
  environmentId: EnvironmentId.make(`environment-${threadId}`),
  threadId,
  providerSessionId: `mcp-session-${threadId}`,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader,
  browserToolsAvailable: true,
});

export const options = (input: { readonly mcp: boolean; readonly deviceToolsAvailable: boolean }) =>
  ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    },
    nativeThreadId: "native-thread-claude-devices",
    resume: false,
    cwd: "/workspace",
    ...(input.mcp
      ? { mcpServers: { "t3-code": { type: "http" as const, url: "http://127.0.0.1/mcp" } } }
      : {}),
    deviceToolsAvailable: input.deviceToolsAvailable,
    environment: {},
  });

export const append = (input: { readonly mcp: boolean; readonly deviceToolsAvailable: boolean }) =>
  (options(input).systemPrompt as { readonly append?: string }).append ?? "";

export const startTurnWithLaunchArgs = Effect.fnUntraced(function* (launchArgs: string, cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
  const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
    instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
    settings: { ...DEFAULT_CLAUDE_SETTINGS, launchArgs },
    environment: {},
    attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-append-" }),
    fileSystem,
    path: yield* Path.Path,
    random: yield* SecureRandom.SecureRandom,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    queryRunner: {
      allocateSessionId: Effect.succeed("native-thread-claude-append-file"),
      open: (input) =>
        Effect.sync(() => {
          opened.push(input.options);
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
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd,
  });
  const threadId = ThreadId.make("thread-claude-append-file");
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-claude-append-file"),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy,
  });
  const exit = yield* runtime
    .startTurn(
      makeClaudeTestTurnInput({
        threadId,
        providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-claude-append-file"),
        text: "What is the sentinel?",
        attachments: [],
        runtimePolicy,
      }),
    )
    .pipe(Effect.exit);
  return { exit, opened };
});

export const appendSystemPrompt = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined) =>
  (options?.systemPrompt as { readonly append?: string } | undefined)?.append;

export const form = (
  properties: Record<string, unknown>,
  required?: ReadonlyArray<string>,
): ElicitationRequest => ({
  serverName: "deploys",
  message: "Deploy web?",
  mode: "form",
  requestedSchema: { type: "object", properties, ...(required ? { required } : {}) },
});

export const captureSdkExecutablePaths = Effect.fn("captureSdkExecutablePaths")(function* (
  binaryPath: string,
  environment: ResolvedProviderInstanceEnvironment = [],
) {
  const executablePaths: Array<string | undefined> = [];
  const taskToolEnvironment: Array<string | undefined> = [];
  const adapter = yield* ClaudeAdapterV2.createClaudeAdapterV2(
    {
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      displayName: undefined,
      environment,
      enabled: true,
      config: { ...DEFAULT_CLAUDE_SETTINGS, binaryPath },
    },
    {},
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-claude-binary-path-",
      }),
    ),
    Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
      allocateSessionId: Effect.succeed("native-thread-claude-binary-path"),
      open: (input) =>
        Effect.sync(() => {
          executablePaths.push(input.options.pathToClaudeCodeExecutable);
          taskToolEnvironment.push(input.options.env?.CLAUDE_CODE_ENABLE_TODO_TOOLS);
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
    }),
  );
  const threadId = ThreadId.make("thread-claude-binary-path");
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-claude-binary-path"),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  });
  yield* runtime.startTurn(
    makeClaudeTestTurnInput({
      threadId,
      providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("attempt-claude-binary-path"),
      text: "hello",
      attachments: [],
    }),
  );
  return { executablePaths, taskToolEnvironment };
});

export function makeFakeClaudeCli(answerSetServers = true) {
  const spawns: Array<SpawnOptions> = [];
  const controlRequests: Array<object> = [];
  const stdins: Array<NodeStream.PassThrough> = [];
  const spawn = (options: SpawnOptions): SpawnedProcess => {
    spawns.push(options);
    const stdin = new NodeStream.PassThrough();
    const stdout = new NodeStream.PassThrough();
    stdins.push(stdin);
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      killed: false,
      exitCode: null as number | null,
      kill: () => {
        stdout.end();
        child.emit("exit", null, "SIGTERM");
        return true;
      },
    });
    let pending = "";
    stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (frame.type !== "control_request") continue;
        controlRequests.push(frame.request);
        const setServers = frame.request.subtype === "mcp_set_servers";
        if (setServers && !answerSetServers) continue;
        const response = {
          subtype: "success",
          request_id: frame.request_id,
          response: setServers ? { added: [], removed: [], errors: {} } : {},
        };
        stdout.write(`${JSON.stringify({ type: "control_response", response })}\n`);
      }
    });
    stdin.on("end", () => {
      stdout.end();
      child.emit("exit", 0, null);
    });
    return child;
  };
  const closed = () => stdins.length > 0 && stdins.every((stdin) => stdin.writableEnded);
  return { spawn, spawns, controlRequests, closed };
}

export const t3McpServer = {
  type: "http" as const,
  url: "http://127.0.0.1:43123/mcp",
  headers: { Authorization: "Bearer dummy-mcp-credential" },
};

export const openWith = (
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

export const openTurnWithOrdinal = (
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

export const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
