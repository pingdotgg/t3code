import { assert, it } from "@effect/vitest";
import { claudeProfileOptions, codexProfileConfig } from "./providerSettings.ts";

it("maps Claude settings without disabling T3 tools or runtime settings", () => {
  const mapped = claudeProfileOptions({
    _tag: "claudeAgent",
    id: "lean",
    settings: {
      blockedTools: [
        "Read",
        "ExitPlanMode",
        "AskUserQuestion",
        "ToolSearch",
        "TaskOutput",
        "TaskStop",
        "TaskCreate",
        "TaskUpdate",
        "TaskList",
        "mcp__t3-code__x",
        "mcp__*",
        "*",
      ],
      bundledSkills: false,
      disabledSkills: ["review"],
      disabledPlugins: ["demo"],
      autoMemory: false,
      coAuthor: false,
      chrome: true,
      settings: {
        autoMemoryEnabled: true,
        permissions: { deny: ["*"] },
        env: { ENABLE_TOOL_SEARCH: "false" },
        hooks: {},
        showThinkingSummaries: false,
      },
    },
  });
  assert.deepEqual(mapped.blockedTools, ["Read"]);
  assert.deepEqual(mapped.settings, {
    disableBundledSkills: true,
    skillOverrides: { review: "off" },
    enabledPlugins: { demo: false },
    autoMemoryEnabled: true,
    attribution: { commit: "", pr: "" },
  });
  assert.isTrue(mapped.chrome);
  assert.deepEqual(
    claudeProfileOptions({ _tag: "pi", id: "other", settings: { skills: false } }).settings,
    {},
  );
});

it("maps Codex features and rejects config that overlaps T3 runtime policy", () => {
  const mapped = codexProfileConfig({
    _tag: "codex",
    id: "lean",
    settings: {
      features: { memories: false, concurrent_reasoning_summaries: false, "bad.key": true },
      config: {
        model_verbosity: "low",
        mcp_servers: {},
        "mcp_servers.t3-code.url": "wrong",
        "mcp_servers.t3-code-direct": {},
        "mcp_servers.other": { enabled: false },
        "shell_environment_policy.set": {},
        sandbox_mode: "danger-full-access",
        approval_policy: "never",
        "tools.update_plan.enabled": false,
        permissions: {},
      },
      disabledSkills: ["review"],
      disabledPlugins: ["demo"],
    },
  });
  assert.deepEqual(mapped.config, {
    "features.memories": false,
    model_verbosity: "low",
    "mcp_servers.other": { enabled: false },
  });
  assert.equal(mapped.refused.length, 10);
  assert.isTrue(mapped.unsupported);
});

it("adds profile MCP servers to Codex as whole tables", () => {
  assert.deepEqual(
    codexProfileConfig(undefined, {
      docs: { type: "http", url: "https://docs.example/mcp", headers: { A: "b" } },
      local: { type: "stdio", command: "npx", args: ["local"], env: {} },
    }).config,
    {
      "mcp_servers.docs": { url: "https://docs.example/mcp", http_headers: { A: "b" } },
      "mcp_servers.local": { command: "npx", args: ["local"] },
    },
  );
});
