import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { t3OrchestrationSections } from "@t3tools/provider-core/server/orchestrationInstructions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as CodexClient from "effect-codex-app-server/client";
import type * as Cause from "effect/Cause";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AssetSigner } from "../assets/AssetSigner.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { DisplayModeWrap } from "./displayModeWrap/DisplayModeWrap.ts";
import { ThreadDashboard } from "./threadDashboard/ThreadDashboard.ts";
import { UserView } from "./userView/UserView.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { PeerForwarding } from "../peer/PeerForwarding.ts";
import { PeerLinkRequests } from "../peer/PeerLinkRequests.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { PreviewBrowser } from "../preview/PreviewBrowser.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { ProjectCloneTracker } from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.ts";
import { mapCodexModelCapabilities } from "../provider/CodexProvider.ts";
import { DocumentText } from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { PullRequestReviewGuideService } from "../pullRequest/PullRequestReviewGuideService.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";

const projectId = ProjectId.make("project:general-role-parity");
const environmentId = EnvironmentId.make("environment:general-role-parity");
const task = "Reply OK.";
const title = "Parity check";
const claudeSettings = Schema.decodeSync(ClaudeSettings)({});
const codexSettings = Schema.decodeSync(CodexSettings)({});
// The runtime mode a person picks for a sidebar thread. The parent thread uses it too.
const runtimeMode = "full-access";
// Browser and device access on, so every MCP capability a sidebar thread can hold is compared.
const serverSettings = ServerSettings.layerTest({
  enableAgentBrowserAccess: true,
  enableAgentDeviceAccess: true,
});

interface ObservedRequest {
  readonly effort: unknown;
  readonly t3Instructions: unknown;
  readonly mcpAuthorization: unknown;
  readonly promptCacheTtl: unknown;
  readonly withoutNoise: unknown;
}

interface ProviderFixture {
  readonly provider: ServerProvider;
  /** The model a person picks for a sidebar thread; the parent thread uses it too. */
  readonly model: string;
  readonly effortOptionId: string;
  readonly efforts: ReadonlyArray<string>;
  /** The prompt-cache TTL a child takes from its subagent setting. A sidebar thread gets none. */
  readonly childPromptCacheTtl: string | undefined;
  /** An adapter that records each thread's first request, read back in the order threads start. */
  readonly recordFirstRequests: Effect.Effect<
    {
      readonly adapter: Effect.Effect<
        ProviderAdapter.ProviderAdapterV2["Service"],
        never,
        McpProviderSessions.McpProviderSessions | Scope.Scope
      >;
      readonly firstRequest: (threadId: ThreadId) => Effect.Effect<ObservedRequest>;
    },
    never,
    Scope.Scope | FileSystem.FileSystem
  >;
}

const providerSnapshot = {
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-04T00:00:00.000Z",
  slashCommands: [],
  skills: [],
} as const;

const valueAt = (node: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>((owner, key) => (Predicate.isObject(owner) ? owner[key] : undefined), node);

// Masks rather than deletes, so a field one thread lacks still shows in the diff.
const maskPath = (node: unknown, [key, ...rest]: ReadonlyArray<string>): unknown =>
  Predicate.isObject(node) && key !== undefined && key in node
    ? { ...node, [key]: rest.length === 0 ? "per-thread" : maskPath(node[key], rest) }
    : node;
const maskPaths = (node: unknown, paths: ReadonlyArray<ReadonlyArray<string>>) =>
  paths.reduce(maskPath, node);

interface ClaudeFirstRequest {
  readonly options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
  readonly message: SDKUserMessage;
}

const claudeChildPromptCacheTtl = "1h";
const claudeAuthorizationPath = ["options", "mcpServers", "t3-code", "headers", "Authorization"];
// Each path holds a value that differs between any two threads: the native session id, the
// message ids and the MCP bearer token.
const claudeNoisePaths = [
  ["options", "sessionId"],
  ["options", "resume"],
  claudeAuthorizationPath,
  ["message", "uuid"],
  ["message", "session_id"],
];

// The prompt-cache TTL leaves the env here; the test checks it on its own.
const claudeWithoutNoise = ({ options, message }: ClaudeFirstRequest) => {
  const { env, canUseTool, onUserDialog, onElicitation, ...rest } = options;
  const { CLAUDE_CODE_PROMPT_CACHE_TTL: _ttl, ...environment } = env ?? {};
  return maskPaths(
    {
      options: {
        ...rest,
        ...(env === undefined ? {} : { env: environment }),
        callbacks: [canUseTool, onUserDialog, onElicitation].map((callback) => typeof callback),
      },
      message,
    },
    claudeNoisePaths,
  );
};

const claude: ProviderFixture = {
  provider: {
    ...providerSnapshot,
    instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
    driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
    models: BUNDLED_CLAUDE_MODEL_CATALOG.models.map((entry) => entry.model),
  },
  model: "claude-opus-5-5",
  effortOptionId: "effort",
  efforts: ["medium", "high"],
  childPromptCacheTtl: claudeChildPromptCacheTtl,
  recordFirstRequests: Effect.gen(function* () {
    const opened = yield* Queue.unbounded<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput>();
    const offered = yield* Queue.unbounded<SDKUserMessage>();
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentsDir = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-general-role-parity-" })
      .pipe(Effect.orDie);
    let sessions = 0;
    return {
      adapter: Effect.gen(function* () {
        return yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: claudeSettings,
          // Fixes the child's TTL, so the developer's own Claude settings do not reach the test.
          environment: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: claudeChildPromptCacheTtl },
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.sync(() => `native-session-${++sessions}`),
            open: (open) =>
              Queue.offer(opened, open).pipe(
                Effect.as({
                  messages: Stream.never,
                  offer: (message: SDKUserMessage) => Queue.offer(offered, message),
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  mcpServerStatus: Effect.succeed([]),
                  readMcpResource: () => Effect.die("unexpected MCP resource read"),
                  callMcpTool: () => Effect.die("unexpected MCP tool call"),
                  listPermissionRules: Effect.die("unexpected permission rules read"),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                }),
              ),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            subagentModel: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
      }).pipe(
        Effect.provide(Layer.mergeAll(IdAllocator.layer, NodeServices.layer, NodeCrypto.layer)),
      ),
      firstRequest: (threadId) =>
        Effect.gen(function* () {
          const open = yield* Queue.take(opened);
          expect(open.threadId).toBe(threadId);
          const request = { options: open.options, message: yield* Queue.take(offered) };
          const { systemPrompt } = request.options;
          return {
            effort: request.options.effort,
            t3Instructions:
              typeof systemPrompt === "object" && "append" in systemPrompt && systemPrompt.append,
            mcpAuthorization: valueAt(request, claudeAuthorizationPath),
            promptCacheTtl: request.options.env?.CLAUDE_CODE_PROMPT_CACHE_TTL,
            withoutNoise: claudeWithoutNoise(request),
          };
        }),
    };
  }),
};

const CodexFrame = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Number),
    method: Schema.String,
    params: Schema.optional(Schema.Unknown),
  }),
);
const decodeCodexFrame = Schema.decodeUnknownSync(CodexFrame);
const decodeCodexTurnStart = Schema.decodeUnknownSync(
  Schema.Struct({
    effort: Schema.optional(Schema.String),
    additionalContext: Schema.Record(Schema.String, Schema.Struct({ value: Schema.String })),
  }),
);

// Each path holds a value that differs between any two threads: the T3 thread id the shell sees,
// the MCP bearer token on both T3 server entries, and the native Codex thread id.
const codexAuthorizationPath = ["config", "mcp_servers.t3-code", "http_headers", "Authorization"];
const codexNoisePaths: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> = {
  "thread/start": [
    ["config", "shell_environment_policy.set.T3CODE_THREAD_ID"],
    codexAuthorizationPath,
    ["config", "mcp_servers.t3-code-direct", "http_headers", "Authorization"],
  ],
  "turn/start": [["threadId"]],
};

const codexWithoutNoise = (frames: ReadonlyArray<typeof CodexFrame.Type>) =>
  frames.map(({ method, params }) => ({
    method,
    params: maskPaths(params, codexNoisePaths[method] ?? []),
  }));

const codexModel = "gpt-6-luna";
const codexReplyFor = (method: string, serial: string) => {
  switch (method) {
    case "initialize":
      return {
        userAgent: "T3 Code/0.156.1",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      };
    case "thread/start":
      return {
        thread: {
          id: `native-thread-${serial}`,
          sessionId: `native-thread-${serial}`,
          projectId: null,
          forkedFromId: null,
          preview: "",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 1782622440,
          updatedAt: 1782622440,
          status: { type: "idle" },
          path: `/tmp/native-thread-${serial}.jsonl`,
          cwd: "/workspace",
          cliVersion: "0.156.1",
          source: "vscode",
          threadSource: null,
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: codexModel,
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace",
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "dangerFullAccess" },
        reasoningEffort: "medium",
      };
    case "turn/start":
      return {
        turn: {
          id: `turn-${serial}`,
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: 1782622440,
          completedAt: null,
          durationMs: null,
        },
      };
    default:
      return undefined;
  }
};

const codex: ProviderFixture = {
  provider: {
    ...providerSnapshot,
    instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
    models: [
      {
        slug: codexModel,
        name: "GPT-6 Luna",
        isCustom: false,
        capabilities: mapCodexModelCapabilities({
          id: codexModel,
          model: codexModel,
          displayName: "GPT-6 Luna",
          description: "",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({
            reasoningEffort,
            description: "",
          })),
        }),
      },
    ],
  },
  model: codexModel,
  effortOptionId: "reasoningEffort",
  efforts: ["medium", "high"],
  childPromptCacheTtl: undefined,
  recordFirstRequests: Effect.gen(function* () {
    const sent = yield* Queue.unbounded<typeof CodexFrame.Type>();
    let replies = 0;
    // A real client over in-memory stdio, so the frames are what the Codex app-server reads.
    const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
      open: () =>
        Effect.gen(function* () {
          const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>();
          return yield* CodexClient.make(
            Stdio.make({
              args: Effect.succeed([]),
              stdin: Stream.fromQueue(stdin),
              stdout: () =>
                Sink.forEach((chunk: string | Uint8Array) => {
                  const frame = decodeCodexFrame(
                    typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
                  );
                  const result = codexReplyFor(frame.method, `${++replies}`);
                  const reply =
                    result === undefined
                      ? { id: frame.id, error: { code: -32601, message: frame.method } }
                      : { id: frame.id, result };
                  return Queue.offer(sent, frame).pipe(
                    Effect.andThen(
                      frame.id === undefined
                        ? Effect.void
                        : Queue.offer(
                            stdin,
                            new TextEncoder().encode(`${JSON.stringify(reply)}\n`),
                          ),
                    ),
                  );
                }),
              stderr: () => Sink.drain,
            }),
          );
        }),
    };
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      adapter: Effect.gen(function* () {
        return yield* CodexAdapterV2.makeCodexAdapterV2({
          instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
          settings: codexSettings,
          environment: {},
          clientFactory,
          digest: yield* Digest.Digest,
          fileSystem,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          serverConfig: yield* ProviderReplayHarness.makeReplayServerConfig(
            "general-role-parity",
          ).pipe(Effect.orDie),
        });
      }).pipe(
        Effect.provide(Layer.mergeAll(IdAllocator.layer, NodeServices.layer, NodeCrypto.layer)),
      ),
      firstRequest: (threadId) =>
        Effect.gen(function* () {
          const frames: Array<typeof CodexFrame.Type> = [];
          // One shared app-server serves every thread, so only the first thread's frames start with initialize.
          while (frames.at(-1)?.method !== "turn/start") frames.push(yield* Queue.take(sent));
          expect(frames.find((frame) => frame.method === "thread/start")?.params).toMatchObject({
            config: { "shell_environment_policy.set.T3CODE_THREAD_ID": threadId },
          });
          const turnStart = decodeCodexTurnStart(frames.at(-1)!.params);
          return {
            effort: turnStart.effort,
            t3Instructions: Object.values(turnStart.additionalContext)
              .map((entry) => entry.value)
              .join("\n\n"),
            mcpAuthorization: valueAt(
              frames.find((frame) => frame.method === "thread/start")?.params,
              codexAuthorizationPath,
            ),
            promptCacheTtl: undefined,
            withoutNoise: codexWithoutNoise(frames),
          };
        }),
    };
  }),
};

const runParity = (input: {
  readonly fixture: ProviderFixture;
  readonly effort: string;
  readonly delegateTarget: "inherit" | "explicit";
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { provider, model, effortOptionId } = input.fixture;
      const instanceId = provider.instanceId;
      const cwd = yield* checkpointWorkspace("general-role-parity");
      const effortOptions = [{ id: effortOptionId, value: input.effort }];
      const modelSelection: ModelSelection = { instanceId, model, options: effortOptions };
      const recorder = yield* input.fixture.recordFirstRequests;
      const mcpSessionRegistry = yield* McpSessionRegistry.__testing.make().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ServerEnvironment)({
              getEnvironmentId: Effect.succeed(environmentId),
            }),
            Layer.mock(HttpServer.HttpServer)({ address: NetAddress.unixPathAddress("") }),
            NodeCrypto.layer,
          ),
        ),
      );
      const layerAdapters = ProviderAdapterRegistry.layerFromAdaptersEffect(
        recorder.adapter.pipe(Effect.map((adapter) => [adapter])),
      ).pipe(Layer.provide(McpProviderSessions.layer));
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name: "general-role-parity" },
        layerAdapters,
        { runEffectWorker: false, mcpSessionRegistry },
      );
      const layerOrchestration = Layer.merge(
        layerOrchestrator,
        ThreadManagementService.layer.pipe(
          Layer.provide(layerOrchestrator),
          Layer.provide(serverSettings),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        ),
      );
      const layerTest = OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provideMerge(layerOrchestration),
        Layer.provide(
          Layer.mergeAll(
            layerAdapters,
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([provider]),
              refreshInstance: () => Effect.succeed([provider]),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            serverSettings,
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      );

      return yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const firstRequest = (threadId: ThreadId) =>
          worker.drain().pipe(Effect.andThen(recorder.firstRequest(threadId)));
        // The sidebar path: the web client creates the thread, then sends the typed text.
        const startFromSidebar = (threadId: ThreadId, text: string) =>
          Effect.gen(function* () {
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`create:${threadId}`),
              threadId,
              projectId,
              title,
              modelSelection,
              runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`send:${threadId}`),
              threadId,
              messageId: MessageId.make(`message:${threadId}`),
              text,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            return yield* firstRequest(threadId);
          });

        const botThreadId = ThreadId.make("thread:bot");
        yield* startFromSidebar(botThreadId, "Start a worker.");
        const sidebarRequest = yield* startFromSidebar(ThreadId.make("thread:sidebar"), task);

        const scope: McpThreadInvocationScope = {
          environmentId,
          requestNamespace: "provider-session:bot",
          thread: {
            threadId: botThreadId,
            providerSessionId: "provider-session:bot",
            providerInstanceId: instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const delegated = yield* service.delegateTask(scope, {
          task,
          title,
          role: "general",
          ...(input.delegateTarget === "explicit"
            ? { target: { providerInstanceId: instanceId, model, options: effortOptions } }
            : {}),
        });
        const childRequest = yield* firstRequest(delegated.childThreadId!);
        const child = yield* orchestrator.getThreadProjection(delegated.childThreadId!);
        // The MCP scope each request's own bearer token grants.
        const grantedScope = (request: ObservedRequest) =>
          mcpSessionRegistry.resolve(String(request.mcpAuthorization).replace(/^Bearer /, ""));
        return {
          sidebarRequest,
          childRequest,
          child,
          sidebarScope: yield* grantedScope(sidebarRequest),
          childScope: yield* grantedScope(childRequest),
        };
      }).pipe(Effect.provide(layerTest));
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.effect.each(
  [claude, codex].flatMap((fixture) =>
    fixture.efforts.flatMap((effort) =>
      (["inherit", "explicit"] as const).map((delegateTarget) => ({
        fixture,
        driver: fixture.provider.driver,
        effort,
        delegateTarget,
      })),
    ),
  ),
)(
  "a general child's first $driver request matches a sidebar thread's (effort $effort, $delegateTarget target)",
  (input) =>
    Effect.gen(function* () {
      const { sidebarRequest, childRequest, child } = yield* runParity(input);

      expect(child.thread.lineage.relationshipToParent).toBe("subagent");
      expect(sidebarRequest.effort).toBe(input.effort);
      expect(sidebarRequest.t3Instructions).toContain(
        t3OrchestrationSections(input.driver).join("\n\n"),
      );
      expect(sidebarRequest.promptCacheTtl).toBeUndefined();
      expect(childRequest.promptCacheTtl).toBe(input.fixture.childPromptCacheTtl);
      expect(childRequest.withoutNoise).toEqual(sidebarRequest.withoutNoise);
    }),
);

// Serving tools/list only reads registrations, so the handlers' services are never called.
const toolHandlerServices = Layer.mergeAll(
  Layer.mock(AssetSigner)({}),
  Layer.mock(DeviceService)({}),
  Layer.mock(ThreadDashboard)({}),
  Layer.mock(UserView)({}),
  Layer.mock(DisplayModeWrap)({ forgetNotesAfterCompaction: () => (ingest) => ingest }),
  Layer.mock(DocumentText)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(GitWorkflowService)({}),
  Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "" }),
  Layer.mock(McpProviderSessions.McpProviderSessions)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(PeerForwarding)({}),
  Layer.mock(PeerLinkRequests)({}),
  Layer.mock(PeerLinks)({}),
  Layer.mock(PreviewAutomationBroker)({}),
  Layer.mock(PreviewBrowser)({}),
  Layer.mock(PreviewManager)({}),
  Layer.mock(ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService)({}),
  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-general-role-parity-" }),
  Layer.mock(ServerEnvironment)({}),
  Layer.mock(ServerSecretStore)({}),
  ServerSettings.layerTest(),
  Layer.mock(SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  McpToolAccessTestkit.liveThreadsLayer,
  Layer.mock(ThreadSearch)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const decodeToolsList = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          description: Schema.optional(Schema.String),
          inputSchema: Schema.Unknown,
        }),
      ),
    }),
  }),
);

it.effect.each([claude, codex].map((fixture) => ({ fixture, driver: fixture.provider.driver })))(
  "a $driver general child holds a sidebar thread's MCP capabilities and lists its tools, but the two PR watch tools",
  ({ fixture }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sidebarScope, childScope } = yield* runParity({
          fixture,
          effort: fixture.efforts[0]!,
          delegateTarget: "inherit",
        });
        // Some capabilities gate a tool only when it is called, so tools/list alone cannot show them.
        expect(childScope?.capabilities).toEqual(sidebarScope?.capabilities);
        const scopes = new Map([
          ["sidebarToken", sidebarScope],
          ["childToken", childScope],
        ]);
        const serverLayer = McpHttpServer.layerMcpTransport(McpHttpServer.layerTools).pipe(
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) => Effect.succeed(scopes.get(token)),
            }),
          ),
          Layer.provide(toolHandlerServices),
        );
        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const httpClient = yield* HttpClient.HttpClient;
        const listedTools = (token: string) =>
          Effect.gen(function* () {
            const headers = {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${token}`,
            };
            const initialize = yield* httpClient.post("/mcp", {
              headers,
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
                "application/json",
              ),
            });
            const listed = yield* httpClient.post("/mcp", {
              headers: {
                ...headers,
                "mcp-session-id": initialize.headers["mcp-session-id"]!,
                "mcp-protocol-version": "2025-06-18",
              },
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
                "application/json",
              ),
            });
            const body = yield* decodeToolsList(yield* listed.json);
            return new Map(
              body.result.tools.map(({ name, description, inputSchema }) => [
                name,
                { name, description, inputSchema },
              ]),
            );
          });

        const sidebarTools = yield* listedTools("sidebarToken");
        const childTools = yield* listedTools("childToken");
        expect(
          ["delegate_task", "preview_open", "device_open"].filter(
            (name) => !sidebarTools.has(name),
          ),
        ).toEqual([]);
        expect([...sidebarTools.keys()].filter((name) => !childTools.has(name)).toSorted()).toEqual(
          ["unwatch_pull_request", "watch_pull_request"],
        );
        expect([...childTools.values()]).toEqual(
          [...sidebarTools.values()].filter((tool) => childTools.has(tool.name)),
        );
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
