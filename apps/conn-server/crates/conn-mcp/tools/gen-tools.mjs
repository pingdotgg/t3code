#!/usr/bin/env node
// Writes src/catalog.jsonl: the tools in tools.implemented, as apps/server's tools/list sends
// them, built in process from McpHttpServer.layerTools. `--check` exits 1 on drift;
// `--all <file>` writes every tool, with `x-conn-hiddenFor` on filtered ones. Needs `vp i`
// in the monorepo.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { schemaRule } from "../../../tools/schema-rules.mjs";
import { monorepo, repoRoot } from "../../../tools/monorepo.mjs";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = monorepo();
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
  ["issue/IssueService.ts", "IssueService"],
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
  ["orchestration-v2/ThreadIssueService.ts", "ThreadIssueService"],
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
// `outside` is a client with no calling thread (a paired device, `t3 auth session issue`);
// the others are agents in a thread.
const scopeFor = (caller) => ({
  environmentId: "environment:gen",
  capabilities: new Set(),
  issuedAt: 0,
  requestNamespace: "gen",
  thread:
    caller === "outside"
      ? undefined
      : {
          threadId: "t",
          providerSessionId: "p",
          providerInstanceId: "claudeAgent",
          subagent: caller === "subagent",
        },
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
        for (const caller of ["outside", "subagent", "links-off"]) {
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
// conn-mcp knows one filter: tools that act as the calling thread are hidden from outside
// clients (`hiddenFromOutsideClients`), listed in src/outside-hidden.txt. Any other filter on
// one of ours would need a Rust check too.
const outsideHidden = [];
const catalog = implemented.map((name) => {
  const { "x-conn-hiddenFor": hiddenFor, ...tool } = byName.get(name);
  if (hiddenFor !== undefined) {
    if (hiddenFor.length !== 1 || hiddenFor[0] !== "outside") {
      console.error(`${name} is hidden for ${hiddenFor.join(", ")}; teach conn-mcp that filter.`);
      process.exit(1);
    }
    outsideHidden.push(`${name}\n`);
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
const instructionsOut = NodePath.join(here, "..", "src", "instructions.txt");
// Claude also gets the adapter's own texts after T3_CODE_ORCHESTRATION_INSTRUCTIONS, which it
// does not export: `T3_CODE_ORCHESTRATION_INSTRUCTIONS + CLAUDE_A + CLAUDE_B + (deviceInstructions
// ? … : "")` in makeClaudeQueryOptions. Read the constant names from that expression, in order,
// so a new or moved text fails `--check` instead of drifting. The device text is left out: this
// server has no device tools, and T3 adds it only with them.
const adapter = NodeFS.readFileSync(
  NodePath.join(server, "src/orchestration-v2/Adapters/ClaudeAdapterV2.ts"),
  "utf8",
);
const appendExpression = /: T3_CODE_ORCHESTRATION_INSTRUCTIONS \+((?:\s*CLAUDE_\w+ \+)+)\s*\(deviceInstructions\b/.exec(
  adapter,
);
if (appendExpression === null) {
  console.error(
    "ClaudeAdapterV2.ts no longer appends `T3_CODE_ORCHESTRATION_INSTRUCTIONS + CLAUDE_… + (deviceInstructions …)`: " +
      "read makeClaudeQueryOptions and teach gen-tools.mjs the new shape.",
  );
  process.exit(1);
}
const claudeTextNames = [...appendExpression[1].matchAll(/CLAUDE_\w+/g)].map((m) => m[0]);
const claudeTexts = claudeTextNames.map((name) => {
  const found = new RegExp(`const ${name} = \`((?:[^\`\\\\]|\\\\.)*)\`;`).exec(adapter);
  if (found === null) {
    console.error(`ClaudeAdapterV2.ts appends ${name} but defines it in a shape gen-tools.mjs cannot read.`);
    process.exit(1);
  }
  return found[1].replace(/\\(.)/g, "$1");
});
const claudeOut = NodePath.join(here, "..", "src", "claude-instructions.txt");
// The `next` text of a running task: the schema takes any string, so the catalog no longer holds it.
const { ORCHESTRATOR_MCP_RUNNING_TASK_NEXT } = await import(
  NodeURL.pathToFileURL(NodePath.join(repo, "packages/contracts/src/orchestratorMcp.ts")).href
);
const runningTaskNextOut = NodePath.join(here, "..", "src", "running-task-next.txt");
// Arguments that keep an explicit `null`. T3 decodes with the JSON codec of each tool's
// schema (`decodeAsAdvertised`), which reads `null` as omitted unless the field itself takes
// `null` (`Schema.NullOr`, as `t3_queue`'s `beforeRunId`). The advertised JSON schema drops
// that `null` branch, so ask each implemented tool's Effect schema directly.
const Schema = await pkg("effect/Schema");
const Exit = await pkg("effect/Exit");
const effectTools = new Map();
const toolkitsDir = NodePath.join(server, "src/mcp/toolkits");
for (const kit of NodeFS.readdirSync(toolkitsDir)) {
  const file = NodePath.join(toolkitsDir, kit, "tools.ts");
  if (!NodeFS.existsSync(file)) continue;
  for (const value of Object.values(await import(NodeURL.pathToFileURL(file).href))) {
    if (value?.tools === undefined) continue;
    for (const [name, tool] of Object.entries(value.tools)) effectTools.set(name, tool);
  }
}
const nullArguments = [];
for (const name of implemented) {
  const tool = effectTools.get(name);
  if (tool === undefined) {
    console.error(`${name}: no toolkit in apps/server/src/mcp/toolkits/*/tools.ts defines it.`);
    process.exit(1);
  }
  for (const [key, field] of Object.entries(tool.parametersSchema.fields ?? {})) {
    if (Exit.isSuccess(Schema.decodeUnknownExit(field)(null))) nullArguments.push(`${name} ${key}\n`);
  }
}
const nullArgumentsOut = NodePath.join(here, "..", "src", "null-arguments.txt");
const outsideHiddenOut = NodePath.join(here, "..", "src", "outside-hidden.txt");
// Every tool apps/server registers, whoever may see it: the tests check the agent texts by it.
const allNamesOut = NodePath.join(here, "..", "fixtures", "t3-tool-names.txt");
const allNames = tools.map((tool) => `${tool.name}\n`).join("");
// Pin catalog search ordering and deferred visibility to T3's implementation.
const { make: makeExposure } = await src("mcp/McpToolExposure.ts");
const searchTools = tools.filter((tool) => implemented.includes(tool.name)).map(({ name, description }) => ({
  name,
  description: description ?? "",
}));
const exposure = makeExposure(() => searchTools, () => Effect.void);
const initiallyListed = searchTools
  .filter((tool) => exposure.isListed("search-test", tool.name))
  .map((tool) => tool.name);
const searchCases = [];
for (const query of [
  "T3_WORKFLOW_STOP",
  "thread",
  "project",
  "thread thread",
  "t3_thread_read",
  "@!!",
  "tool_search",
  "environment, schedule",
]) {
  const found = await Effect.runPromise(exposure.search("search-test", query));
  searchCases.push({ query, names: found.map((tool) => tool.name) });
}
const searchOut = NodePath.join(here, "..", "fixtures", "tool-search.json");
for (let index = 0; index < 300; index++) {
  await Effect.runPromise(exposure.search(`session-${index}`, "t3_workflow_stop"));
}
const retainedSessions = Array.from({ length: 300 }, (_, index) => index).filter((index) =>
  exposure.isListed(`session-${index}`, "t3_workflow_stop"),
).length;
const searchText = JSON.stringify({ initiallyListed, retainedSessions, cases: searchCases }, null, 2) + "\n";
const exposureSource = NodeFS.readFileSync(NodePath.join(repo, "apps/server/src/mcp/McpToolExposure.ts"), "utf8");
const exposureLimit = (name) => {
  const value = new RegExp(`const ${name} = (\\d+);`).exec(exposureSource)?.[1];
  if (value === undefined) throw new Error(`MCP exposure limit ${name} moved`);
  return value;
};
const exposureLimitsOut = NodePath.join(here, "..", "src", "exposure", "generated.rs");
const exposureLimits = [
  "// @generated by tools/gen-tools.mjs from McpToolExposure.ts. Do not edit.",
  "",
  `pub(super) const MAX_SESSIONS: usize = ${exposureLimit("MAX_SESSIONS")};`,
  `pub(super) const MAX_RESULTS: usize = ${exposureLimit("MAX_RESULTS")};`,
  "pub(super) const DIRECT: &[&str] = &[",
  ...initiallyListed.map((name) => `    ${JSON.stringify(name)},`),
  "];", "",
].join("\n");

const { injectHtmlRenderBootstrap, HTML_RENDER_MIN_HEIGHT, HTML_RENDER_MAX_HEIGHT, HTML_RENDER_MAX_TITLE_LENGTH } = await import(
  NodeURL.pathToFileURL(NodePath.join(repo, "packages/shared/src/htmlRender.ts")).href
);
const bootstrap = injectHtmlRenderBootstrap('<head><!--conn-bootstrap-end--></head>');
const markup = bootstrap.slice(bootstrap.indexOf('<style id="t3-theme">'), bootstrap.indexOf('<!--conn-bootstrap-end-->'));
if (!markup.startsWith('<style') || !markup.endsWith('</script>')) throw new Error("HTML bootstrap shape changed");
const inlineHtmlLimit = tools.find((tool) => tool.name === "html_render")?.inputSchema?.properties?.html?.maxLength;
if (!Number.isSafeInteger(inlineHtmlLimit) || inlineHtmlLimit < 1) throw new Error("HTML inline limit moved");
// A UTF-16 unit needs at most six JSON bytes (\\uXXXX); leave 64 KiB for the RPC envelope.
const httpLimitsOut = NodePath.join(here, "../src/http-limits.rs");
const httpLimitsText = `// Generated by tools/gen-tools.mjs from T3's html_render schema. Do not edit.\npub const MAX_MCP_BODY_BYTES: usize = 6 * (${inlineHtmlLimit} + ${HTML_RENDER_MAX_TITLE_LENGTH}) + 64 * 1024;\n`;
const { T3_MCP_TOOL_NAMES } = await import(NodeURL.pathToFileURL(NodePath.join(repo, "packages/shared/src/t3McpToolPresentation.ts")).href);
const { MCP_APP_OUTPUT_KEY } = await import(NodeURL.pathToFileURL(NodePath.join(repo, "packages/shared/src/mcpApp.ts")).href);
const toolOutputConstantsOut = NodePath.join(here, "../../conn-provider/src/tool-output-constants.rs");
const toolOutputSource = NodeFS.readFileSync(NodePath.join(repo,"packages/shared/src/toolOutput.ts"),"utf8");
const htmlSource = NodeFS.readFileSync(NodePath.join(repo,"packages/shared/src/htmlRender.ts"),"utf8");
const privateLimit = (source,name) => {
  const value = new RegExp(`const ${name} = ([\\d_]+);`).exec(source)?.[1];
  if (!value) throw new Error(`${name} moved`);
  return value;
};
const toolOutputConstants = `// Generated by conn-mcp/tools/gen-tools.mjs. Do not edit.\nconst TOOL_NAMES: &[&str] = &[${[...T3_MCP_TOOL_NAMES].map((name) => JSON.stringify(name)).join(",")}];\nconst HTML_RENDER_MIN_HEIGHT: i64 = ${HTML_RENDER_MIN_HEIGHT};\nconst HTML_RENDER_MAX_HEIGHT: i64 = ${HTML_RENDER_MAX_HEIGHT};\nconst HTML_RENDER_MAX_TITLE_LENGTH: usize = ${HTML_RENDER_MAX_TITLE_LENGTH};\nconst MAX_MEASURED_HEIGHTS: usize = ${privateLimit(htmlSource,"MAX_MEASURED_HEIGHTS")};\nconst SEND_TO_USER_MAX_LENGTH: usize = ${privateLimit(toolOutputSource,"SEND_TO_USER_MAX_LENGTH")};\npub(crate) const MCP_APP_OUTPUT_KEY: &str = ${JSON.stringify(MCP_APP_OUTPUT_KEY)};\n`;
const htmlOut = NodePath.join(here, "../../conn-files/src/html-bootstrap.json");
const htmlText = JSON.stringify({markup, minHeight: HTML_RENDER_MIN_HEIGHT, maxHeight: HTML_RENDER_MAX_HEIGHT, maxTitleLength: HTML_RENDER_MAX_TITLE_LENGTH}) + "\n";
// MCP's advertised schemas omit decode-time checks and string normalization.
const threadInputs = {};
for (const [module,name] of [["attachment","AttachmentToolkit"],["worktree","WorktreeToolkit"],["orchestrator","OrchestratorToolkit"],["toolSearch","ToolSearchToolkit"],["credentials","CredentialsToolkit"],["panels","PanelsToolkit"]]) {
  const toolkit = (await src(`mcp/toolkits/${module}/tools.ts`))[name];
  for (const [name,tool] of Object.entries(toolkit.tools)) {
    if (!["create_threads","t3_attachment_prepare_upload","t3_attachment_discard","t3_thread_send_attachments","t3_worktree_handoff","t3_worktree_list","t3_workflow_stop","tool_search","save_test_login","request_credentials","database_query","mcp_call","mcp_connect"].includes(name)) continue;
    threadInputs[name] = schemaRule(tool.parametersSchema.ast, "decode");
  }
}
const threadInputsOut = NodePath.join(here,"..","src","thread-inputs.json");
const secretContracts = await import(NodeURL.pathToFileURL(NodePath.join(repo, "packages/contracts/src/secretRequest.ts")).href);
const secretSource = NodeFS.readFileSync(NodePath.join(repo, "packages/contracts/src/secretRequest.ts"), "utf8");
const failureMessages = /const SECRET_REQUEST_FAILURE_MESSAGES = \{([\s\S]+?)\} as const;/.exec(secretSource)?.[1];
if (!failureMessages) throw new Error("Secret request failure messages moved");
const reasons = [...failureMessages.matchAll(/^  (\w+):/gm)].map((m) => m[1]);
const secretTexts = JSON.stringify({ notes: secretContracts.SECRET_REQUEST_UNSAVED_NOTE, errors: Object.fromEntries(reasons.map((reason) => [reason, new secretContracts.SecretRequestError({reason}).message])) }) + "\n";
await import("../../conn-preview/gen-spec.mjs");
const { PreviewAutomationUnavailableError } = await import(NodeURL.pathToFileURL(NodePath.join(repo,"packages/contracts/src/previewAutomation.ts")).href);
const previewUnavailable = new PreviewAutomationUnavailableError({capability:"preview", environmentId:"fixture"}).message;
const outputs = [
  [searchOut, searchText, "tool search cases"],
  [exposureLimitsOut, exposureLimits, "tool search limits"],
  [toolOutputConstantsOut, toolOutputConstants, "T3 tool names and output limits"],
  [httpLimitsOut, httpLimitsText, "MCP HTTP body limit"],
  [htmlOut, htmlText, "HTML render bootstrap and height limits"],
  [NodePath.join(here,"..","src","preview-unavailable.txt"),previewUnavailable,"preview capability refusal"],
  [threadInputsOut,`${JSON.stringify(threadInputs)}\n`,"thread tool input checks"],
  [NodePath.join(here, "..", "..", "conn-features", "src", "secret-texts.json"), secretTexts, "secret request texts"],
  [out, text, `${catalog.length} tools`],
  [outsideHiddenOut, outsideHidden.join(""), `${outsideHidden.length} tools hidden from outside clients`],
  [allNamesOut, allNames, `${tools.length} tool names`],
  [runningTaskNextOut, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT, "running task next text"],
  [nullArgumentsOut, nullArguments.join(""), `${nullArguments.length} arguments that keep null`],
  [instructionsOut, T3_CODE_ORCHESTRATION_INSTRUCTIONS, "agent instructions"],
  [claudeOut, claudeTexts.join(""), `Claude texts (${claudeTextNames.join(" + ")})`],
];
if (process.argv.includes("--check")) {
  for (const [file, content, what] of outputs) {
    const current = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "";
    if (current !== content) {
      console.error(
        `${NodePath.relative(repoRoot, file)} is stale: run gen-tools.mjs and review the diff.`,
      );
      process.exit(1);
    }
    console.log(`${what} match ${NodePath.relative(repoRoot, file)}`);
  }
} else {
  for (const [file, content, what] of outputs) {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, content);
    console.log(`wrote ${what} to ${NodePath.relative(repoRoot, file)}`);
  }
}
