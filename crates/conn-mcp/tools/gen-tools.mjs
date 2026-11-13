#!/usr/bin/env node
// Writes src/catalog.jsonl: the tools in tools.implemented, as apps/server's tools/list sends
// them, built in process from McpHttpServer.layerTools. `--check` exits 1 on drift;
// `--all <file>` writes every tool, with `x-conn-hiddenFor` on filtered ones. Needs `vp i`
// in the monorepo (`CONN_MONOREPO`).
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepoRoot } from "./monorepo.mjs";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = monorepoRoot;
const server = NodePath.join(repo, "apps/server");
const out = NodePath.join(here, "..", "src", "catalog.jsonl");
const implemented = NodeFS.readFileSync(NodePath.join(here, "..", "tools.implemented"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));
const require = NodeModule.createRequire(NodePath.join(server, "package.json"));
const pkg = (name) => import(NodeURL.pathToFileURL(require.resolve(name)).href);
const src = (path) => import(NodeURL.pathToFileURL(NodePath.join(server, "src", path)).href);

const Effect = await pkg("effect/Effect");
const Layer = await pkg("effect/Layer");
const Context = await pkg("effect/Context");
const { McpServer, McpSchema } = await pkg("effect/ai");
const NodeServices = await pkg("@effect/platform-node/NodeServices");
const NodeCrypto = await pkg("@effect/platform-node/NodeCrypto");
const McpHttpServer = await src("mcp/McpHttpServer.ts");
const McpInvocationContext = await src("mcp/McpInvocationContext.ts");

// The services the tool handlers declare. Registration only stores definitions, so none is
// called. Keep in step with AgentContextBudget.test.ts; a missing one fails layer build loudly.
const mocked = [
  ["annotations/AnnotationStore.ts", "AnnotationStore"],
  ["panels/AgentPanelBroker.ts", "AgentPanelBroker"],
  ["credentials/CredentialAutofill.ts", "CredentialAutofill"],
  ["assets/AssetSigner.ts", "AssetSigner"],
  ["device/DeviceService.ts", "DeviceService"],
  ["provider/DocumentText.ts", "DocumentText"],
  ["vcs/GitVcsDriver.ts", "GitVcsDriver"],
  ["git/GitWorkflowService.ts", "GitWorkflowService"],
  ["orchestration-v2/Orchestrator.ts", "OrchestratorV2"],
  ["peer/PeerForwarding.ts", "PeerForwarding"],
  ["peer/PeerLinkRequests.ts", "PeerLinkRequests"],
  ["peer/PeerLinks.ts", "PeerLinks"],
  ["mcp/PreviewAutomationBroker.ts", "PreviewAutomationBroker"],
  ["preview/PreviewBrowser.ts", "PreviewBrowser"],
  ["preview/Manager.ts", "PreviewManager"],
  ["project/ProjectCloneTracker.ts", "ProjectCloneTracker"],
  ["project/ProjectService.ts", "ProjectService"],
  ["project/ProjectSetupScriptRunner.ts", "ProjectSetupScriptRunner"],
  ["orchestration-v2/ProviderAdapterRegistry.ts", "ProviderAdapterRegistryV2"],
  ["provider/ProviderRegistry.ts", "ProviderRegistry"],
  ["pullRequest/PullRequestReviewGuideService.ts", "PullRequestReviewGuideService"],
  ["pullRequest/PullRequestService.ts", "PullRequestService"],
  ["peer/RemoteDelegation.ts", "RemoteDelegation"],
  ["scheduledTasks/ScheduledTaskService.ts", "ScheduledTaskService"],
  ["secrets/SecretRequests.ts", "SecretRequests"],
  ["environment/ServerEnvironment.ts", "ServerEnvironment"],
  ["auth/ServerSecretStore.ts", "ServerSecretStore"],
  ["serverSettings.ts", "ServerSettingsService"],
  ["sourceControl/SourceControlRepositoryService.ts", "SourceControlRepositoryService"],
  ["orchestration-v2/ThreadLaunchService.ts", "ThreadLaunchService"],
  ["orchestration-v2/ThreadManagementService.ts", "ThreadManagementService"],
  ["orchestration-v2/ThreadSearch.ts", "ThreadSearch"],
  ["vcs/VcsStatusBroadcaster.ts", "VcsStatusBroadcaster"],
];
const mocks = [];
for (const [path, name] of mocked) mocks.push(Layer.mock((await src(path))[name])({}));
// Workspace packages export `import` conditions only, which require.resolve cannot read.
const { McpProviderSessions } = await import(
  NodeURL.pathToFileURL(
    NodePath.join(repo, "packages/provider-core/src/server/McpProviderSessions.ts"),
  ).href
);
mocks.push(Layer.mock(McpProviderSessions)({}));
const { ManagedProjectFolders } = await src("project/ManagedProjectFolders.ts");
mocks.push(Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "" }));
const { ServerConfig } = await src("config.ts");
mocks.push(ServerConfig.layerTest(process.cwd(), { prefix: "conn-mcp-gen-tools-" }));

const services = Layer.mergeAll(...mocks).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layer = Layer.mergeAll(McpHttpServer.layerTools, McpHttpServer.layerToolSearch).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(services),
);

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// The 2025-06-18 `tools/list` projection (effect/src/ai/internal/mcpProtocol/v2025_06_18.ts):
// the annotation title is lifted to `title`, and an output schema that is not a plain object
// schema (a union, say) is left out.
const listed = (tool) => {
  const output = tool.outputSchema;
  const keepOutput =
    isObject(output) &&
    output.type === "object" &&
    (output.properties === undefined ||
      (isObject(output.properties) && Object.values(output.properties).every(isObject))) &&
    (output.required === undefined ||
      (Array.isArray(output.required) && output.required.every((r) => typeof r === "string")));
  const title = tool.title ?? tool.annotations?.title;
  const result = { name: tool.name };
  if (title !== undefined) result.title = title;
  if (tool.description !== undefined) result.description = tool.description;
  result.inputSchema = tool.inputSchema;
  if (keepOutput) result.outputSchema = output;
  if (tool.annotations !== undefined) result.annotations = tool.annotations;
  if (tool._meta !== undefined) result._meta = tool._meta;
  return result;
};

// What each EnabledWhen filter says for a caller: run it with that caller in the fiber.
const scopeFor = (caller) => ({
  environmentId: "environment:gen",
  capabilities: new Set(),
  issuedAt: 0,
  requestNamespace: "gen",
  thread:
    caller === "subagent"
      ? { threadId: "t", providerSessionId: "p", providerInstanceId: "claudeAgent", subagent: true }
      : undefined,
  client: undefined,
  linkedEnvironments: caller !== "links-off",
});

const tools = await Effect.runPromise(
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const result = [];
    for (const { tool, annotations } of mcp.tools) {
      const enabledWhen = Context.getOption(annotations, McpSchema.EnabledWhen);
      const hiddenFor = [];
      if (enabledWhen._tag === "Some") {
        for (const caller of ["subagent", "links-off"]) {
          const shown = yield* Effect.sync(() => enabledWhen.value({})).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(caller)),
          );
          if (shown === false) hiddenFor.push(caller);
        }
      }
      result.push({
        ...listed(JSON.parse(JSON.stringify(tool))),
        ...(hiddenFor.length === 0 ? {} : { "x-conn-hiddenFor": hiddenFor }),
      });
    }
    return result;
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

const allAt = process.argv.indexOf("--all");
if (allAt !== -1) {
  NodeFS.writeFileSync(process.argv[allAt + 1], `${JSON.stringify({ tools }, null, 2)}\n`);
  console.log(`wrote all ${tools.length} tools to ${process.argv[allAt + 1]}`);
  process.exit(0);
}
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const missing = implemented.filter((name) => !byName.has(name));
if (missing.length > 0) {
  console.error(`apps/server no longer registers: ${missing.join(", ")}`);
  process.exit(1);
}
// Filtered tools are none of ours yet; a filter on one would need a Rust check too.
const catalog = implemented.map((name) => {
  const { "x-conn-hiddenFor": hiddenFor, ...tool } = byName.get(name);
  if (hiddenFor !== undefined) {
    console.error(`${name} is hidden for ${hiddenFor.join(", ")}; teach conn-mcp that filter.`);
    process.exit(1);
  }
  return tool;
});
// One compact tool per line: conn-mcp splices these bytes into `tools/list` unparsed.
const text = catalog.map((tool) => `${JSON.stringify(tool)}\n`).join("");
// The orchestration text T3 appends to an agent's system prompt when it has `t3-code`.
const { T3_CODE_ORCHESTRATION_INSTRUCTIONS } = await import(
  NodeURL.pathToFileURL(
    NodePath.join(repo, "packages/provider-core/src/server/orchestrationInstructions.ts"),
  ).href
);
const instructionsOut = NodePath.join(here, "..", "src", "instructions.md");
// Claude also gets CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS, which the adapter does not export.
const adapter = NodeFS.readFileSync(
  NodePath.join(server, "src/orchestration-v2/Adapters/ClaudeAdapterV2.ts"),
  "utf8",
);
const backgroundWait = /const CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS = `((?:[^`\\]|\\.)*)`;/.exec(
  adapter,
);
if (backgroundWait === null) {
  console.error("ClaudeAdapterV2.ts no longer defines CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS.");
  process.exit(1);
}
const claudeOut = NodePath.join(here, "..", "src", "claude-background-wait.md");
const outputs = [
  [out, text, `${catalog.length} tools`],
  [instructionsOut, T3_CODE_ORCHESTRATION_INSTRUCTIONS, "agent instructions"],
  [claudeOut, backgroundWait[1].replace(/\\(.)/g, "$1"), "Claude background-wait text"],
];
if (process.argv.includes("--check")) {
  for (const [file, content, what] of outputs) {
    const current = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "";
    if (current !== content) {
      console.error(
        `${NodePath.relative(repo, file)} is stale: run gen-tools.mjs and review the diff.`,
      );
      process.exit(1);
    }
    console.log(`${what} match ${NodePath.relative(repo, file)}`);
  }
} else {
  for (const [file, content, what] of outputs) {
    NodeFS.writeFileSync(file, content);
    console.log(`wrote ${what} to ${NodePath.relative(repo, file)}`);
  }
}
