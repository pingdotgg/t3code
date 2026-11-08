import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import { AssetSigner } from "../assets/AssetSigner.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type { McpInvocationScope, McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import { PeerForwarding } from "../peer/PeerForwarding.ts";
import { PeerLinkRequests } from "../peer/PeerLinkRequests.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { RemoteDelegation } from "../peer/RemoteDelegation.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { PreviewBrowser } from "../preview/PreviewBrowser.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { ProjectCloneTracker } from "../project/ProjectCloneTracker.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { PullRequestReviewGuideService } from "../pullRequest/PullRequestReviewGuideService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { SecretRequests } from "../secrets/SecretRequests.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";
import { DocumentText } from "./DocumentText.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";
import budget from "./agentContextBudget.json" with { type: "json" };

// Registration only stores tool definitions, so the handlers' services are never called.
const toolHandlerServices = Layer.mergeAll(
  Layer.mock(AssetSigner)({}),
  Layer.mock(DeviceService)({}),
  Layer.mock(DocumentText)({}),
  Layer.mock(GitVcsDriver)({}),
  Layer.mock(GitWorkflowService)({}),
  Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "" }),
  Layer.mock(McpProviderSessions)({}),
  Layer.mock(OrchestratorV2)({}),
  Layer.mock(PeerForwarding)({}),
  Layer.mock(PeerLinkRequests)({}),
  Layer.mock(PeerLinks)({}),
  Layer.mock(PreviewAutomationBroker)({}),
  Layer.mock(PreviewBrowser)({}),
  Layer.mock(PreviewManager)({}),
  Layer.mock(ProjectCloneTracker)({}),
  Layer.mock(ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService)({}),
  Layer.mock(RemoteDelegation)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(SecretRequests)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-context-budget-" }),
  Layer.mock(ServerEnvironment)({}),
  Layer.mock(ServerSecretStore)({}),
  Layer.mock(ServerSettingsService)({}),
  Layer.mock(SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(ThreadSearch)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

const claudeSystemAppend = () => {
  const { systemPrompt } = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
      model: "claude-opus-5-5",
    },
    nativeThreadId: "context-budget",
    resume: false,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
  });
  return typeof systemPrompt === "object" && "append" in systemPrompt ? systemPrompt.append : "";
};

const codexAdditionalContext = () =>
  Object.values(
    buildCodexAdditionalContext(
      { model: "gpt-6.1-sol", modelName: "GPT-6.1 Sol", reasoningEffort: "high" },
      { browser: true, device: true },
    ),
  )
    .map((entry) => entry.value)
    .join("");

const layerAdvertisedTools = McpHttpServer.layerTools.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(toolHandlerServices),
);

// Claude Code loads these tools up front instead of behind ToolSearch, outside this budget.
it.effect("only request_secret asks Claude Code to load it up front", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const alwaysLoad = mcp.tools
      .filter(({ tool }) => tool._meta?.["anthropic/alwaysLoad"] !== undefined)
      .map(({ tool }) => [tool.name, tool._meta]);
    expect(alwaysLoad).toEqual([["request_secret", { "anthropic/alwaysLoad": true }]]);
  }).pipe(Effect.provide(layerAdvertisedTools)),
);

// Each of these acts as the calling thread, so a client from outside a thread can only fail them.
const THREAD_BOUND_TOOLS = [
  "create_threads",
  "delegate_task",
  "device_close",
  "device_list",
  "device_open",
  "device_screenshot",
  "html_preview",
  "html_render",
  "preview_act",
  "preview_dialog",
  "preview_evaluate",
  "preview_navigate",
  "preview_open",
  "preview_recording_start",
  "preview_recording_stop",
  "preview_resize",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_status",
  "preview_wait_for",
  "request_secret",
  "t3_background_wait",
  "t3_preview_close",
  "t3_preview_list",
  "t3_worktree_handoff",
  "t3_worktree_status",
  "task_cancel",
  "task_status",
];

it.effect("offers a thread its own tools and an outside client none of them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const capabilities = new Set(["orchestration", "worktree", "pull-requests"] as const);
      const environmentId = EnvironmentId.make("environment");
      const thread: McpThreadInvocationScope = {
        environmentId,
        requestNamespace: "thread",
        thread: {
          threadId: ThreadId.make("thread"),
          providerSessionId: "thread",
          providerInstanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
        },
        client: undefined,
        capabilities,
        issuedAt: 1,
      };
      const outside: McpInvocationScope = {
        environmentId,
        requestNamespace: "client:outside",
        thread: undefined,
        client: { sessionId: "outside", label: "Outside agent", access: "full-access" },
        capabilities,
        issuedAt: 1,
      };
      yield* HttpRouter.serve(
        McpHttpServer.layerMcpTransport(McpHttpServer.layerTools).pipe(
          Layer.provide(
            Layer.mock(McpSessionRegistry)({
              resolve: (token) => Effect.succeed(token === "thread" ? thread : undefined),
            }),
          ),
          Layer.provide(
            Layer.succeed(McpHttpServer.McpClientAuthenticator, {
              authenticate: () => Effect.succeed(outside),
            }),
          ),
          Layer.provide(
            Layer.mock(ServerSettingsService)({
              managedPolicy: undefined,
              getSettings: Effect.succeed({ linkedEnvironmentsEnabled: true } as never),
            }),
          ),
          Layer.provide(toolHandlerServices),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const session = Effect.fn("session")(function* (token: string) {
        const headers = {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        };
        const initialized = yield* client.post("/mcp", {
          headers,
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
            "application/json",
          ),
        });
        return (method: string, params: object) =>
          client
            .post("/mcp", {
              headers: {
                ...headers,
                "mcp-session-id": initialized.headers["mcp-session-id"]!,
                "mcp-protocol-version": "2025-06-18",
              },
              body: HttpBody.text(
                JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
                "application/json",
              ),
            })
            .pipe(Effect.flatMap((response) => response.json));
      });
      const names = (body: unknown) =>
        (body as { result: { tools: ReadonlyArray<{ name: string }> } }).result.tools.map(
          (tool) => tool.name,
        );

      const asThread = yield* session("thread");
      const offeredToThread = names(yield* asThread("tools/list", {}));
      expect(offeredToThread).toEqual(expect.arrayContaining(THREAD_BOUND_TOOLS));

      const asOutside = yield* session("outside");
      const offeredOutside = names(yield* asOutside("tools/list", {}));
      expect(offeredOutside.filter((name) => THREAD_BOUND_TOOLS.includes(name))).toEqual([]);
      // Everything else stays: outside clients drive threads through these.
      expect(offeredOutside.toSorted()).toEqual(
        offeredToThread.filter((name) => !THREAD_BOUND_TOOLS.includes(name)).toSorted(),
      );

      // A client with an old list gets a refusal, and SecretRequests is never reached.
      const refused = yield* asOutside("tools/call", {
        name: "request_secret",
        arguments: { label: "Probe", reason: "Probe" },
      });
      expect(refused).toMatchObject({
        error: { message: expect.stringContaining("request_secret") },
      });

      // A thread call of a hidden-outside tool reaches its handler. This thread lacks the
      // preview capability, so the handler's own refusal proves the call got past discovery.
      const previewCall = { name: "preview_status", arguments: {} };
      expect(yield* asThread("tools/call", previewCall)).toMatchObject({
        result: {
          isError: true,
          content: [{ text: expect.stringContaining("does not grant the preview capability") }],
        },
      });
      expect(yield* asOutside("tools/call", previewCall)).toMatchObject({
        error: { message: "Tool 'preview_status' not found" },
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

// CI rejects a PR that raises any value above main's agentContextBudget.json, so growth
// needs the agent-context-increase label. Lower the values when the text shrinks.
it.effect("agent context matches the committed budget", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const measured = {
      claudeSystemAppendBytes: utf8Bytes(claudeSystemAppend()),
      codexAdditionalContextBytes: utf8Bytes(codexAdditionalContext()),
      // The model sees these fields. outputSchema and annotations are protocol metadata.
      mcpToolListJsonBytes: utf8Bytes(
        JSON.stringify(
          mcp.tools.map(({ tool }) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ),
      ),
    };

    expect(
      measured,
      "Set agentContextBudget.json to the measured values. Before you cut text to fit, run the evals that cover it (evals/README.md).",
    ).toEqual(budget);
  }).pipe(Effect.provide(layerAdvertisedTools)),
);
