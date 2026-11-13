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

export const providerThreadJson = Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ProviderThread));

export const encodeProviderThreadJson = Schema.encodeEffect(providerThreadJson);

export const decodeProviderThreadJson = Schema.decodeUnknownEffect(providerThreadJson);

export const WAKE_NATIVE_SESSION = "native-thread-claude-wake";

export const WAKE_TASK_ID = "bdqirlcyw";

export const WAKE_TOOL_USE_ID = "toolu_01Rs6JNNf5SqHRxpq5DeJHrW";

export const WAKE_TASK_DESCRIPTION = "Background sleep test";

export const WAKE_SUMMARY = 'Background command "Background sleep test" completed (exit code 0)';

export const WAKE_ASSISTANT_TEXT = "WAKE_DONE";

export const WAKE_RESULT_TEXT = "WAKE_DONE";

export function claudeSdkFrame(frame: unknown): SDKMessage {
  if (
    typeof frame !== "object" ||
    frame === null ||
    typeof Reflect.get(frame, "type") !== "string"
  ) {
    throw new Error("Frame is not a Claude Agent SDK message.");
  }
  return frame as SDKMessage;
}

export const wakeTaskStarted = claudeSdkFrame({
  type: "system",
  subtype: "task_started",
  task_id: WAKE_TASK_ID,
  tool_use_id: WAKE_TOOL_USE_ID,
  description: WAKE_TASK_DESCRIPTION,
  is_backgrounded: true,
  task_type: "local_bash",
  uuid: "00000000-0000-4000-8000-000000000101",
  session_id: WAKE_NATIVE_SESSION,
});

export const makeAssistantTextFrame = (input: { readonly uuid: string; readonly text: string }) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: input.text }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const makeAssistantErrorFrame = (input: {
  readonly uuid: string;
  readonly error:
    | "authentication_failed"
    | "invalid_request"
    | "rate_limit"
    | "server_error"
    | undefined;
  readonly text?: string;
  readonly parentToolUseId?: string | null;
  readonly apiErrorParams?: unknown;
}) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: input.text ?? "Claude could not complete this request." }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: input.parentToolUseId ?? null,
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.apiErrorParams === undefined ? {} : { api_error_params: input.apiErrorParams }),
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const makeResultFrame = (input: {
  readonly uuid: string;
  readonly result: string;
  readonly numTurns?: number;
  readonly origin?: { readonly kind: "task-notification" };
  readonly subtype?: string;
  readonly isError?: boolean;
  readonly errors?: ReadonlyArray<string>;
  readonly apiErrorStatus?: number;
  // null omits the field, as the CLI does on a zero-turn result.
  readonly terminalReason?: SDKResultMessage["terminal_reason"] | null;
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens: number;
    readonly cache_read_input_tokens: number;
  };
  readonly modelUsage?: SDKResultMessage["modelUsage"];
}) =>
  claudeSdkFrame({
    type: "result",
    subtype: input.subtype ?? "success",
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: input.isError ?? false,
    num_turns: input.numTurns ?? 1,
    result: input.result,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: input.usage ?? {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: input.modelUsage ?? {},
    permission_denials: [],
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.errors === undefined ? {} : { errors: input.errors }),
    ...(input.apiErrorStatus === undefined ? {} : { api_error_status: input.apiErrorStatus }),
    ...(input.terminalReason === null
      ? {}
      : { terminal_reason: input.terminalReason ?? "completed" }),
  });

export const turnOneResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000102",
  result: "Kicked off the build in the background.",
});

export const wakeNotification = claudeSdkFrame({
  type: "system",
  subtype: "task_notification",
  task_id: WAKE_TASK_ID,
  tool_use_id: WAKE_TOOL_USE_ID,
  status: "completed",
  output_file: `/tmp/claude-replay/tasks/${WAKE_TASK_ID}.output`,
  summary: WAKE_SUMMARY,
  uuid: "00000000-0000-4000-8000-000000000103",
  session_id: WAKE_NATIVE_SESSION,
});

export const wakeAssistant = makeAssistantTextFrame({
  uuid: "00000000-0000-4000-8000-000000000107",
  text: WAKE_ASSISTANT_TEXT,
});

export const wakeTurnInit = claudeSdkFrame({
  type: "system",
  subtype: "init",
  uuid: "00000000-0000-4000-8000-000000000110",
  session_id: WAKE_NATIVE_SESSION,
});

export const wakeResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000104",
  result: WAKE_RESULT_TEXT,
  origin: { kind: "task-notification" },
});

export const STALE_TASK_NOTIFICATION_RESULT_TEXT =
  "Stale task-notification origin text that must not appear.";

export const staleTaskNotificationResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000106",
  result: STALE_TASK_NOTIFICATION_RESULT_TEXT,
  numTurns: 0,
  origin: { kind: "task-notification" },
  terminalReason: null,
});

// Harnesses notify after every recorded event, continuation, or prompt, so a
// wait re-checks exactly when the state it reads changes. Subscribing before
// the first check means a change that lands in between is not lost.

export const makeChangeSignal = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<void>();
  const until = (predicate: () => boolean): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        while (!predicate()) yield* PubSub.take(subscription);
      }),
    );
  return { notify: PubSub.publish(changes, undefined), until };
});

// Fixed quiet windows for asserting that nothing happens after input the
// harness cannot observe being handled (a shut-down query, a replaced process).

export const yieldTicks = (ticks: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow;
  });

export const makeWakeHarnessWithOptions = (options?: {
  readonly close?: (sdkMessages: Queue.Queue<SDKMessage>) => Effect.Effect<void>;
  readonly interrupt?: Effect.Effect<void>;
  readonly setPermissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["setPermissionMode"];
  readonly applyFlagSettings?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["applyFlagSettings"];
  readonly stopTask?: (
    taskId: string,
  ) => Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
  readonly backgroundTasks?: (
    toolUseId: string,
  ) => Effect.Effect<boolean, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly subagentLaunchToolUseId?: string;
  readonly nativeSessionId?: string;
  readonly settings?: ClaudeSettings;
  readonly freshQueueOnReopen?: boolean;
  readonly forkSession?: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape["forkSession"];
  readonly allocateSessionId?: Effect.Effect<string>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-v2-wake-",
    });
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const processQueues: Array<Queue.Queue<SDKMessage>> = [];
    const processedMessages = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
    const offerAndWait = Effect.fnUntraced(function* (
      message: SDKMessage,
      offered?: Deferred.Deferred<void>,
    ) {
      const processed = yield* Deferred.make<void>();
      processedMessages.set(message, processed);
      yield* Queue.offer(processQueues.at(-1) ?? sdkMessages, message);
      if (offered !== undefined) yield* Deferred.succeed(offered, undefined);
      yield* Deferred.await(processed);
    });
    const changes = yield* makeChangeSignal;
    const offeredMessages: Array<SDKUserMessage> = [];
    const permissionModeChanges: Array<string> = [];
    const liveSelectionChanges: Array<unknown> = [];
    const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
      [];
    const continuationReceipts =
      yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
    const terminalReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
      >();
    const subagentReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }>
      >();
    const systemNoticeReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>
      >();
    const runtimeRequestReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
      >();
    const planReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "plan.updated" }>
      >();
    const providerThreadReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "provider_thread.updated" }>
      >();
    let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: options?.settings ?? DEFAULT_CLAUDE_SETTINGS,
      environment: options?.environment ?? {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator,
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationRequests.push(request);
          }).pipe(
            Effect.andThen(Queue.offer(continuationReceipts, request)),
            Effect.andThen(changes.notify),
          ),
      },
      queryRunner: {
        allocateSessionId:
          options?.allocateSessionId ??
          Effect.succeed(options?.nativeSessionId ?? WAKE_NATIVE_SESSION),
        open: (input) =>
          Effect.gen(function* () {
            openedOptions = input.options;
            const processMessages =
              options?.freshQueueOnReopen === true && processQueues.length > 0
                ? yield* Queue.unbounded<SDKMessage>()
                : sdkMessages;
            const messages = Stream.fromQueue(processMessages).pipe(
              Stream.flatMap((message) =>
                Stream.make(message).pipe(
                  Stream.concat(
                    Stream.fromEffect(
                      Effect.suspend(() => {
                        const processed = processedMessages.get(message);
                        return processed === undefined
                          ? Effect.void
                          : Deferred.succeed(processed, undefined);
                      }),
                    ).pipe(Stream.drain),
                  ),
                ),
              ),
            );
            if (options?.freshQueueOnReopen === true && processQueues.length > 0) {
              processQueues.push(processMessages);
              return {
                messages,
                offer: (message: SDKUserMessage) =>
                  Effect.sync(() => {
                    offeredMessages.push(message);
                  }).pipe(Effect.andThen(changes.notify)),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: (mode) =>
                  Effect.sync(() => {
                    permissionModeChanges.push(mode);
                  }).pipe(
                    Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void),
                  ),
                backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
                stopTask: options?.stopTask ?? (() => Effect.void),
                interrupt: Effect.void,
                close: Queue.shutdown(processMessages),
              };
            }
            processQueues.push(sdkMessages);
            return {
              messages,
              offer: (message) =>
                Effect.sync(() => {
                  offeredMessages.push(message);
                }).pipe(Effect.andThen(changes.notify)),
              setModel: (model) =>
                Effect.sync(() => {
                  liveSelectionChanges.push({ model });
                }),
              applyFlagSettings: (settings) =>
                Effect.sync(() => {
                  liveSelectionChanges.push(settings);
                }).pipe(
                  Effect.andThen(() => options?.applyFlagSettings?.(settings) ?? Effect.void),
                ),
              setPermissionMode: (mode) =>
                Effect.sync(() => {
                  permissionModeChanges.push(mode);
                }).pipe(Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void)),
              backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
              stopTask: options?.stopTask ?? (() => Effect.void),
              interrupt: options?.interrupt ?? Effect.void,
              close: options?.close?.(sdkMessages) ?? Effect.void,
            };
          }),
        forkSession: options?.forkSession ?? (() => Effect.die("unused forkSession")),
        subagentLaunchToolUseId: () => Effect.succeed(options?.subagentLaunchToolUseId ?? null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make("thread-claude-wake");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-wake"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "subagent.updated") {
            yield* Queue.offer(subagentReceipts, event);
          }
          if (event.type === "turn.terminal") {
            yield* Queue.offer(terminalReceipts, event);
          }
          if (event.type === "runtime_request.updated") {
            yield* Queue.offer(runtimeRequestReceipts, event);
          }
          if (event.type === "plan.updated") {
            yield* Queue.offer(planReceipts, event);
          }
          if (event.type === "provider_thread.updated") {
            yield* Queue.offer(providerThreadReceipts, event);
          }
          if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") {
            yield* Queue.offer(systemNoticeReceipts, event);
          }
          yield* changes.notify;
        }),
      ),
      Effect.forkScoped,
    );
    if (runtime.hasPendingBackgroundWork === undefined) {
      throw new Error("Claude adapter runtime must expose hasPendingBackgroundWork.");
    }
    const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
    const terminalEvents = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    return {
      attachmentsDir,
      runtime,
      providerThread,
      threadId,
      sdkMessages,
      processQueues,
      offerAndWait,
      offeredMessages,
      promptUuid: (index: number) => {
        const uuid = offeredMessages[index]?.uuid;
        if (uuid === undefined) throw new Error(`No prompt offered at index ${index}.`);
        return uuid;
      },
      permissionModeChanges,
      liveSelectionChanges,
      continuationRequests,
      continuationReceipts,
      events,
      terminalReceipts,
      subagentReceipts,
      systemNoticeReceipts,
      runtimeRequestReceipts,
      planReceipts,
      providerThreadReceipts,
      getOpenedOptions: () => openedOptions,
      terminalEvents,
      hasPendingBackgroundWork,
      until: changes.until,
      awaitTerminal: (count: number) => changes.until(() => terminalEvents().length >= count),
      awaitContinuation: (count: number) =>
        changes.until(() => continuationRequests.length >= count),
    };
  });

export const makeWakeHarness = makeWakeHarnessWithOptions();

export const attachmentBudgetOutcomes = [
  "resume",
  "legacy",
  "compacted",
  "preserved-segment",
  "preserved-messages",
  "failed",
  "stopped",
  "fork-bytes",
  "fork-pages",
] as const;

export const openPlanTurn = Effect.fn("openPlanTurn")(function* (
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

export const requestWrite = Effect.fn("requestPlanWrite")(function* (
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

export const testLayer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);

export const approvalOnly: ElicitationRequest = {
  serverName: "deploys",
  message: "Deploy web to production?",
  mode: "form",
  requestedSchema: { type: "object", properties: {} },
  title: "Deploy",
};

export const startElicitationTurn = Effect.fnUntraced(function* (
  options?: Parameters<typeof makeWakeHarnessWithOptions>[0],
) {
  const harness = yield* makeWakeHarnessWithOptions(options);
  yield* harness.runtime.startTurn(
    makeClaudeTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("attempt-claude-elicitation"),
      text: "Deploy web.",
      attachments: [],
    }),
  );
  const onElicitation = harness.getOpenedOptions()?.onElicitation;
  if (onElicitation === undefined) throw new Error("The Claude query has no onElicitation.");
  const runtimeRequests = () =>
    harness.events.flatMap((event) =>
      event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
    );
  let requestNumber = 0;
  const elicit = (request: ElicitationRequest, signal = new AbortController().signal) =>
    Effect.promise(() =>
      onElicitation(request, { signal, requestId: `sdk-${requestNumber++}` }),
    ).pipe(Effect.forkScoped);
  const awaitCard = Effect.fnUntraced(function* (count: number) {
    const event = yield* Queue.take(harness.runtimeRequestReceipts);
    assert.equal(runtimeRequests().length, count);
    return event.runtimeRequest;
  });
  return { harness, elicit, awaitCard, runtimeRequests };
});

export const lastProviderTurn = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
  const event = events.findLast((candidate) => candidate.type === "provider_turn.updated");
  if (event?.type !== "provider_turn.updated") {
    throw new Error("Expected a provider turn update.");
  }
  return event.providerTurn;
};

export const makeRollbackHarness = makeWakeHarnessWithOptions({
  close: (sdkMessages) => Queue.shutdown(sdkMessages),
});

export const usageStreamFrame = (event: unknown, parentToolUseId: string | null = null) =>
  claudeSdkFrame({
    type: "stream_event",
    event,
    parent_tool_use_id: parentToolUseId,
    session_id: WAKE_NATIVE_SESSION,
    uuid: "usage-stream-frame",
  });

export const usageSnapshotFrame = (id: string, uuid: string, usage: unknown) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Working." }],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
    parent_tool_use_id: null,
    uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const zeroUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export const reportedContextTokens = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) =>
    event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
      ? [event.providerTurn.tokenUsage.usedTokens]
      : [],
  );

export type TaskToolCall =
  | { name: "TaskCreate"; input: TaskCreateInput; output: TaskCreateOutput }
  | { name: "TaskUpdate"; input: TaskUpdateInput; output: TaskUpdateOutput }
  | { name: "TaskList"; input: Record<string, never>; output: TaskListOutput };

export function taskToolFrames(
  tool: TaskToolCall,
  nextUuid: () => string,
  options?: {
    parentToolUseId?: string;
    isError?: boolean;
    extraToolResult?: boolean;
    nonExecutionKind?: string;
  },
): ReadonlyArray<SDKMessage> {
  const uuid = nextUuid();
  const toolUseId = `tool-${uuid}`;
  const parentToolUseId = options?.parentToolUseId ?? null;
  return [
    claudeSdkFrame({
      type: "assistant",
      message: {
        id: `msg_${uuid}`,
        model: "claude-sonnet-4-6",
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: tool.name, input: tool.input }],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: parentToolUseId,
      uuid,
      session_id: WAKE_NATIVE_SESSION,
    }),
    claudeSdkFrame({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content:
              parentToolUseId !== null && tool.name === "TaskCreate"
                ? `Task #${tool.output.task.id} created successfully: ${tool.output.task.subject}`
                : parentToolUseId !== null && tool.name === "TaskUpdate"
                  ? tool.output.success
                    ? `Updated task #${tool.output.taskId} ${tool.output.updatedFields.join(", ")}`
                    : tool.output.error
                  : "Task tool finished.",
            ...(options?.isError === undefined ? {} : { is_error: options.isError }),
          },
          ...(options?.extraToolResult
            ? [{ type: "tool_result", tool_use_id: "unrelated-tool", content: "ok" }]
            : []),
        ],
      },
      // Like real Claude, subagent results carry only the text, no `tool_use_result`.
      ...(parentToolUseId === null ? { tool_use_result: tool.output } : {}),
      ...(options?.nonExecutionKind === undefined
        ? {}
        : {
            tool_result_meta: [{ id: toolUseId, non_execution_kind: options.nonExecutionKind }],
          }),
      parent_tool_use_id: parentToolUseId,
      uuid: nextUuid(),
      session_id: WAKE_NATIVE_SESSION,
    }),
  ];
}

export const makeTaskToolHarnessWithOptions = (environment: NodeJS.ProcessEnv = {}) =>
  Effect.gen(function* () {
    const configDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "t3-claude-tasks-",
    });
    const path = yield* Path.Path;
    const harness = yield* makeWakeHarnessWithOptions({
      environment: {
        CLAUDE_CONFIG_DIR: path.relative(CLAUDE_TEST_RUNTIME_POLICY.cwd ?? ".", configDir),
        ...environment,
      },
    });
    let sequence = 600;
    let turn = 0;
    const nextUuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    const startTurn = Effect.fnUntraced(function* () {
      turn++;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`attempt-claude-task-tools-${turn}`),
          providerTurnOrdinal: turn,
          text: "Update the task list.",
          attachments: [],
        }),
      );
    });
    const call = Effect.fnUntraced(function* (
      tool: TaskToolCall,
      options?: Parameters<typeof taskToolFrames>[2],
    ) {
      for (const frame of taskToolFrames(tool, nextUuid, options)) {
        yield* harness.offerAndWait(frame);
      }
    });
    const finishTurn = Effect.fnUntraced(function* () {
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: nextUuid(), result: "Task list updated." }),
      );
      return yield* Queue.take(harness.terminalReceipts);
    });
    const plans = () =>
      harness.events.flatMap((event) =>
        event.type === "plan.updated" && event.plan.kind === "todo_list" ? [event.plan] : [],
      );
    // Registers a running subagent so frames carrying its tool_use_id as
    // parent_tool_use_id are processed instead of held for an unknown owner.
    const launchSubagent = (toolUseId: string) =>
      harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: `task-${toolUseId}`,
          tool_use_id: toolUseId,
          description: "Work on tasks",
          task_type: "local_agent",
          uuid: nextUuid(),
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
    return { configDir, startTurn, call, launchSubagent, finishTurn, plans };
  });

export const makeTaskToolHarness = makeTaskToolHarnessWithOptions();

export const createTask = (id: string, subject: string): TaskToolCall => ({
  name: "TaskCreate",
  input: { subject: `Requested ${subject}`, description: `Work on ${subject}.` },
  output: { task: { id, subject } },
});

export const updateTask = (input: TaskUpdateInput, success = true): TaskToolCall => ({
  name: "TaskUpdate",
  input,
  output: { success, taskId: input.taskId, updatedFields: ["status"] },
});

export const providerThreadRosterEvents = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
) =>
  events.filter(
    (
      event,
    ): event is Extract<
      ProviderAdapter.ProviderAdapterV2Event,
      { type: "provider_thread.updated" }
    > => event.type === "provider_thread.updated",
  );

export const makeSubagentAssistantFrames = (input: {
  readonly parentToolUseId: string;
  readonly uuid: string;
  readonly messageId?: string;
  readonly text?: string;
  readonly bashToolUseId?: string;
}): ReadonlyArray<SDKMessage> =>
  [
    ...(input.text === undefined ? [] : [{ type: "text", text: input.text }]),
    ...(input.bashToolUseId === undefined
      ? []
      : [
          {
            type: "tool_use",
            id: input.bashToolUseId,
            name: "Bash",
            input: { command: "git log -5" },
          },
        ]),
  ].map((block, index) =>
    claudeSdkFrame({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id: input.messageId ?? `msg_${input.uuid}`,
        type: "message",
        role: "assistant",
        content: [block],
      },
      parent_tool_use_id: input.parentToolUseId,
      uuid: index === 0 ? input.uuid : `${input.uuid}:${index}`,
      session_id: WAKE_NATIVE_SESSION,
    }),
  );

export const makeSubagentToolResultFrame = (input: {
  readonly parentToolUseId: string;
  readonly uuid: string;
  readonly toolUseId: string;
}) =>
  claudeSdkFrame({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: input.toolUseId, content: "ok" }],
    },
    parent_tool_use_id: input.parentToolUseId,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const makeSubagentTaskStartedFrame = (input: {
  readonly taskId: string;
  readonly toolUseId: string;
  readonly uuid: string;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_started",
    task_id: input.taskId,
    tool_use_id: input.toolUseId,
    description: "Audit recent commits",
    subagent_type: "general-purpose",
    is_backgrounded: true,
    task_type: "local_agent",
    prompt: "Audit the last five commits.",
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const makeSubagentNotificationFrame = (input: {
  readonly taskId: string;
  readonly toolUseId: string;
  readonly summary: string;
  readonly uuid: string;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_notification",
    task_id: input.taskId,
    tool_use_id: input.toolUseId,
    status: "completed",
    output_file: `/tmp/${input.taskId}.output`,
    summary: input.summary,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const subagentRouting = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  nativeToolIds: ReadonlyArray<string>,
) => {
  const childThreadId =
    events.find((event) => event.type === "subagent.updated")?.subagent.childThreadId ??
    undefined;
  const toolThreadIds = new Map<string, Set<string>>();
  for (const event of events) {
    const nativeId =
      event.type === "turn_item.updated" ? event.turnItem.nativeItemRef?.nativeId : undefined;
    if (event.type === "turn_item.updated" && nativeId && nativeToolIds.includes(nativeId)) {
      toolThreadIds.set(
        nativeId,
        (toolThreadIds.get(nativeId) ?? new Set()).add(event.turnItem.threadId),
      );
    }
  }
  const assistantTexts = (threadId: string | undefined) =>
    events.flatMap((event) =>
      event.type === "message.updated" &&
      event.message.role === "assistant" &&
      event.message.threadId === threadId
        ? [event.message.text]
        : [],
    );
  return { childThreadId, toolThreadIds, assistantTexts };
};

export const stopRacedByReplacementTurn = (label: string) =>
  Effect.gen(function* () {
    const changes = yield* makeChangeSignal;
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: `t3-claude-v2-${label}-`,
    });
    const processQueues: Array<Queue.Queue<SDKMessage>> = [];
    // The first two processes exit only when the test ends their streams.
    const closeRequested = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
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
            const closeSignal = closeRequested[processQueues.length];
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
              close:
                closeSignal === undefined
                  ? Queue.shutdown(sdkMessages)
                  : Deferred.succeed(closeSignal, undefined).pipe(Effect.asVoid),
            };
          }),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make(`thread-claude-${label}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-claude-${label}`),
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
    const subagentStatus = (taskId: string) => {
      const latest = events.findLast(
        (event) =>
          event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === taskId,
      );
      return latest?.type === "subagent.updated" ? latest.subagent.status : undefined;
    };
    const now = yield* DateTime.now;

    yield* runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId,
        providerThread,
        now,
        attemptId: RunAttemptId.make(`attempt-claude-${label}-a`),
        text: "Audit the last commits in the background.",
        attachments: [],
      }),
    );
    yield* Queue.offer(
      processQueues[0]!,
      makeSubagentTaskStartedFrame({
        taskId: "raced-agent",
        toolUseId: "toolu-raced-agent",
        uuid: "00000000-0000-4000-8000-000000002801",
      }),
    );
    yield* Queue.offer(
      processQueues[0]!,
      makeResultFrame({
        uuid: "00000000-0000-4000-8000-000000002802",
        result: "Launched the audit.",
      }),
    );
    yield* changes.until(
      () => terminals().length === 1 && subagentStatus("raced-agent") === "running",
    );

    const stop = yield* runtime
      .interruptTurn({
        providerThread,
        providerTurnId: terminals()[0]!.providerTurnId,
        requestRuntimeRestart: true,
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(closeRequested[0]!);
    yield* runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId,
        providerThread: { ...providerThread, status: "active" },
        now,
        attemptId: RunAttemptId.make(`attempt-claude-${label}-b`),
        text: "Resume after the limit reset.",
        attachments: [],
        providerTurnOrdinal: 2,
      }),
    );
    assert.lengthOf(processQueues, 2);
    yield* Queue.offer(
      processQueues[1]!,
      makeSubagentTaskStartedFrame({
        taskId: "own-agent",
        toolUseId: "toolu-own-agent",
        uuid: "00000000-0000-4000-8000-000000002804",
      }),
    );
    yield* changes.until(() => subagentStatus("own-agent") === "running");
    const exitProcess = <E>(index: number, stopping: Fiber.Fiber<void, E>) =>
      Queue.shutdown(processQueues[index]!).pipe(Effect.andThen(Fiber.join(stopping)));
    return {
      runtime,
      threadId,
      providerThread,
      processQueues,
      closeRequested,
      changes,
      terminals,
      subagentStatus,
      exitFirstProcess: exitProcess(0, stop),
      exitProcess,
      now,
    };
  });

// regression: #28331 a subagent whose process is gone must not stay running forever

export const makeStopFixture = (options?: Parameters<typeof makeWakeHarnessWithOptions>[0]) =>
  Effect.gen(function* () {
    const requests = yield* Queue.unbounded<void>();
    const harness = yield* makeWakeHarnessWithOptions({
      ...options,
      stopTask: (id) =>
        Queue.offer(requests, undefined).pipe(
          Effect.andThen(options?.stopTask?.(id) ?? Effect.void),
        ),
    });
    let sequence = 4500;
    const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    const startTurn = (continuation = false) =>
      harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: DateTime.makeUnsafe(0),
          attemptId: RunAttemptId.make(`attempt-stop-${continuation ? 2 : 1}`),
          providerTurnOrdinal: continuation ? 2 : 1,
          text: "Run an audit.",
          attachments: [],
          ...(continuation
            ? { messageCreatedBy: "agent" as const, messageCreationSource: "provider" as const }
            : {}),
        }),
      );
    const start = (toolUseId = "toolu-stop-agent") =>
      harness.offerAndWait(
        makeSubagentTaskStartedFrame({
          taskId: "stop-agent",
          toolUseId,
          uuid: uuid(),
        }),
      );
    const notify = (
      status: "completed" | "failed" | "stopped",
      summary = "Native outcome.",
      toolUseId = "toolu-stop-agent",
    ) =>
      harness.offerAndWait(
        claudeSdkFrame({
          ...makeSubagentNotificationFrame({
            taskId: "stop-agent",
            toolUseId,
            summary,
            uuid: uuid(),
          }),
          status,
        }),
      );
    const stop = (requestedAt?: DateTime.Utc) =>
      harness.runtime.stopSubagent!({
        providerThread: harness.providerThread,
        nativeTaskId: "stop-agent",
        ...(requestedAt === undefined ? {} : { requestedAt }),
      });
    const finishParent = () =>
      harness
        .offerAndWait(makeResultFrame({ uuid: uuid(), result: "Launched." }))
        .pipe(Effect.andThen(Queue.take(harness.terminalReceipts)));
    yield* startTurn();
    yield* start();
    yield* Queue.take(harness.subagentReceipts);
    return {
      ...harness,
      start,
      notify,
      stop,
      finishParent,
      replay: () => startTurn(true),
      uuid,
      requests,
    };
  });

export const WORKFLOW_TASK_ID = "task-workflow-run";

export const WORKFLOW_TOOL_USE_ID = "toolu-workflow-run";

export const makeWorkflowHarnessWithOptions = (
  options?: Parameters<typeof makeWakeHarnessWithOptions>[0],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-wf-" });
    const transcriptDir = NodePath.join(configDir, "projects", "workflow");
    yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
    yield* fileSystem.writeFileString(
      NodePath.join(transcriptDir, "agent-a1.jsonl"),
      `{"type":"assistant","effort":"xhigh","uuid":"wf-line-1-${options?.nativeSessionId ?? "default"}","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_a1","usage":{"speed":"standard"},"content":[{"type":"text","text":"A1 from the transcript"}]}}\n`,
    );
    const harness = yield* makeWakeHarnessWithOptions({
      ...options,
      environment: { ...options?.environment, CLAUDE_CONFIG_DIR: configDir },
    });
    return { ...harness, transcriptDir };
  });

export const makeWorkflowHarness = makeWorkflowHarnessWithOptions();

export const workflowToolUse = claudeSdkFrame({
  type: "assistant",
  message: {
    model: "claude-sonnet-4-6",
    content: [
      {
        type: "tool_use",
        id: WORKFLOW_TOOL_USE_ID,
        name: "Workflow",
        input: { script: "alpha.js" },
      },
    ],
  },
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-000000001001",
  session_id: WAKE_NATIVE_SESSION,
});

export const workflowTaskStarted = claudeSdkFrame({
  type: "system",
  subtype: "task_started",
  task_id: WORKFLOW_TASK_ID,
  tool_use_id: WORKFLOW_TOOL_USE_ID,
  description: "Run the alpha workflow",
  task_type: "local_workflow",
  workflow_name: "probe-wf",
  uuid: "00000000-0000-4000-8000-000000001002",
  session_id: WAKE_NATIVE_SESSION,
});

export const workflowLaunchAck = (transcriptDir: string) =>
  claudeSdkFrame({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: WORKFLOW_TOOL_USE_ID,
          content: [{ type: "text", text: "Workflow launched." }],
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000001003",
    session_id: WAKE_NATIVE_SESSION,
    tool_use_result: {
      taskType: "local_workflow",
      runId: "wf_probe",
      transcriptDir,
    },
  });

export const workflowSnapshot = (input: {
  readonly uuid: string;
  readonly state: "queued" | "start" | "done";
  readonly secondState?: "queued" | "start" | "done";
  readonly startedAt?: number;
  readonly lastProgressAt?: number;
  readonly durationMs?: number;
  readonly label?: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly attempt?: number;
  readonly omitResult?: boolean;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_progress",
    task_id: WORKFLOW_TASK_ID,
    tool_use_id: WORKFLOW_TOOL_USE_ID,
    description: "Alpha: alpha:one",
    workflow_progress: [
      { type: "workflow_phase", index: 1, title: "Alpha" },
      {
        type: "workflow_agent",
        index: 1,
        label: input.label ?? "alpha:one",
        agentId: "a1",
        state: input.state,
        phaseIndex: 1,
        phaseTitle: "Alpha",
        model: input.model ?? "claude-opus-5[1m]",
        promptPreview: input.prompt ?? "Reply with exactly: A1",
        ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
        ...(input.lastProgressAt === undefined ? {} : { lastProgressAt: input.lastProgressAt }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
        ...(input.state === "done" && input.omitResult !== true
          ? { resultPreview: "A1 excerpt" }
          : {}),
      },
      {
        type: "workflow_agent",
        index: 2,
        label: "alpha:two",
        agentId: "a2",
        state: input.secondState ?? input.state,
        phaseIndex: 1,
        phaseTitle: "Alpha",
        promptPreview: "Reply with exactly: A2",
        ...(input.state === "done" ? { resultPreview: "A2 excerpt" } : {}),
      },
    ],
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const workflowNotification = (input: {
  readonly uuid: string;
  readonly status: "completed" | "failed" | "stopped";
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_notification",
    task_id: WORKFLOW_TASK_ID,
    tool_use_id: WORKFLOW_TOOL_USE_ID,
    status: input.status,
    summary: "Workflow finished.",
    output_file: "/tmp/workflow.output",
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const workflowCoordinatorEvents = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
) =>
  events.filter(
    (
      event,
    ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
      event.type === "subagent.updated" &&
      event.subagent.nativeTaskRef?.nativeId === WORKFLOW_TASK_ID,
  );

export const workflowMemberEvents = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  index: number,
) =>
  events.filter(
    (
      event,
    ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
      event.type === "subagent.updated" &&
      event.subagent.nativeTaskRef?.nativeId?.endsWith(`:agent:${index}`) === true,
  );

export const threadMessages = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  threadId: ThreadId | null | undefined,
) =>
  events.filter(
    (
      event,
    ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "message.updated" }> =>
      event.type === "message.updated" && event.message.threadId === threadId,
  );

export const launchWorkflow = Effect.fnUntraced(function* (input: {
  readonly harness: Effect.Success<typeof makeWorkflowHarness>;
  readonly snapshotUuid: string;
  readonly state?: "queued" | "start";
}) {
  yield* input.harness.offerAndWait(workflowToolUse);
  yield* input.harness.offerAndWait(workflowTaskStarted);
  yield* input.harness.offerAndWait(workflowLaunchAck(input.harness.transcriptDir));
  yield* input.harness.offerAndWait(
    workflowSnapshot({ uuid: input.snapshotUuid, state: input.state ?? "start" }),
  );
  yield* input.harness.until(() => workflowMemberEvents(input.harness.events, 2).length === 1);
});

export const transcriptLine = (entry: Record<string, unknown>) =>
  `${JSON.stringify({ isSidechain: true, agentId: "a1", timestamp: "2026-10-17T05:08:07.524Z", ...entry })}\n`;

export const memberAssistantLine = (
  uuid: string,
  messageId: string,
  content: unknown,
  stopReason?: "tool_use" | "end_turn",
) =>
  transcriptLine({
    type: "assistant",
    uuid,
    message: {
      model: "claude-opus-5-5",
      id: messageId,
      type: "message",
      role: "assistant",
      content,
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    },
  });

export const memberToolResultLine = (uuid: string, toolUseId: string, output: string) =>
  transcriptLine({
    type: "user",
    uuid,
    message: {
      role: "user",
      content: [{ tool_use_id: toolUseId, type: "tool_result", content: output }],
    },
  });

export const memberTranscript = [
  transcriptLine({
    type: "user",
    uuid: "line-prompt",
    message: { role: "user", content: "Reply with exactly: A1" },
  }),
  transcriptLine({
    type: "attachment",
    uuid: "line-attachment",
    attachment: { type: "skill_listing", content: "- adhd" },
  }),
  transcriptLine({
    type: "user",
    uuid: "line-meta",
    isMeta: true,
    message: { role: "user", content: "<system-reminder>context</system-reminder>" },
  }),
  memberAssistantLine("line-thinking", "msg_a1", [
    { type: "thinking", thinking: "List the files first.", signature: "sig" },
  ]),
  memberAssistantLine("line-bash", "msg_a1", [
    { type: "tool_use", id: "toolu_a1_ls", name: "Bash", input: { command: "ls" } },
  ]),
  memberToolResultLine("line-ls-result", "toolu_a1_ls", "README.md"),
  memberAssistantLine("line-reply", "msg_a1_reply", [
    { type: "text", text: "A1 found README.md" },
  ]),
].join("");

export const memberThreadItems = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  threadId: ThreadId | null | undefined,
) =>
  events.flatMap((event) =>
    event.type === "turn_item.updated" && event.turnItem.threadId === threadId
      ? [event.turnItem]
      : [],
  );

export const latestMemberThreadItems = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  threadId: ThreadId | null | undefined,
) =>
  [
    ...new Map(memberThreadItems(events, threadId).map((item) => [item.id, item])).values(),
  ].toSorted((left, right) => left.ordinal - right.ordinal);

export const describeItem = (item: ReturnType<typeof memberThreadItems>[number]) =>
  item.type === "reasoning"
    ? `reasoning: ${item.text}`
    : item.type === "command_execution"
      ? `command ${item.status}: ${item.output ?? ""}`
      : item.type === "assistant_message" || item.type === "user_message"
        ? `${item.type}`
        : `${item.type} ${item.status}`;

export const syntheticFrame = (uuid: string, text: string) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "<synthetic>",
      id: uuid,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const stopHookFeedback = (uuid: string, condition: string, reason: string) =>
  claudeSdkFrame({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: `Stop hook feedback:\n[${condition}]: ${reason}` }],
    },
    parent_tool_use_id: null,
    isSynthetic: true,
    uuid,
    session_id: WAKE_NATIVE_SESSION,
  });

export const goalStatuses = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) =>
    event.type === "provider_thread.updated" && event.providerThread.goal != null
      ? [event.providerThread.goal]
      : [],
  );
