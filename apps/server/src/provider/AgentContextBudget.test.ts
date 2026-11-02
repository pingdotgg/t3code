import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
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
).pipe(Layer.provideMerge(NodeServices.layer));

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
  }).pipe(
    Effect.provide(
      McpHttpServer.layerTools.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(toolHandlerServices),
      ),
    ),
  ),
);
