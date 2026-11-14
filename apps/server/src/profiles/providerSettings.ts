import type { ResolvedProviderSettings } from "@t3tools/contracts";
import type { ProfileMcpServerLaunch } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as Schema from "effect/Schema";

// These drive T3's plan/dialog, task tracking, and deferred MCP tool flows.
const claudeProtectedTools = new Set([
  "ExitPlanMode",
  "EnterPlanMode",
  "AskUserQuestion",
  "ToolSearch",
  "TaskOutput",
  "TaskStop",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "Agent",
  "Task",
  "Monitor",
]);
const claudeProtectedSettings = new Set([
  "permissions",
  "hooks",
  "env",
  "mcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "enableAllProjectMcpServers",
  "allowedMcpServers",
  "deniedMcpServers",
  "tools",
  "allowedTools",
  "disallowedTools",
  "permissionMode",
  "disableAllHooks",
  "showThinkingSummaries",
  "alwaysThinkingEnabled",
  "model",
  "effortLevel",
]);

export function claudeProfileOptions(resolved: ResolvedProviderSettings | undefined) {
  const value = resolved?._tag === "claudeAgent" ? resolved.settings : {};
  const advanced = Object.fromEntries(
    Object.entries(value.settings ?? {}).filter(
      ([key]) => !claudeProtectedSettings.has(key.split(".")[0]!),
    ),
  );
  return {
    blockedTools: (value.blockedTools ?? []).filter((tool) => {
      const name = tool.split("(")[0]!;
      // Broad patterns can also match T3's own MCP tools.
      return (
        !/[?*]/.test(name) && !name.startsWith("mcp__t3-code") && !claudeProtectedTools.has(name)
      );
    }),
    chrome: value.chrome === true,
    settings: {
      ...(value.bundledSkills === undefined ? {} : { disableBundledSkills: !value.bundledSkills }),
      ...(value.disabledSkills === undefined
        ? {}
        : {
            skillOverrides: Object.fromEntries(value.disabledSkills.map((name) => [name, "off"])),
          }),
      ...(value.disabledPlugins === undefined
        ? {}
        : {
            enabledPlugins: Object.fromEntries(value.disabledPlugins.map((name) => [name, false])),
          }),
      ...(value.autoMemory === undefined ? {} : { autoMemoryEnabled: value.autoMemory }),
      ...(value.coAuthor === false ? { attribution: { commit: "", pr: "" } } : {}),
      ...advanced,
    },
  };
}

const codexProtectedKeys = [
  "mcp_servers.t3-code",
  "mcp_servers.t3-code-direct",
  "shell_environment_policy",
  "sandbox_mode",
  "sandbox_workspace_write",
  "approval_policy",
  "approvals_reviewer",
  "permissions",
  "default_permissions",
  "tools.update_plan.enabled",
  "mcp_optional_startup_grace_ms",
  "features.concurrent_reasoning_summaries",
  "developer_instructions",
  "instructions",
  "model_instructions_file",
  "profile",
  "profiles",
];
const overlaps = (key: string, protectedKey: string) =>
  key === protectedKey || key.startsWith(`${protectedKey}.`) || protectedKey.startsWith(`${key}.`);

// Command servers go in mcp-servers.json, behind each machine's Allow MCP commands switch.
const MCP_EXECUTION_KEYS = new Set(["command", "args", "env"]);
const definesMcpCommand = (key: string, entry: Schema.Json): boolean => {
  const parts = key.split(".");
  if (parts[0] !== "mcp_servers") return false;
  if (parts.length > 2) return MCP_EXECUTION_KEYS.has(parts[2]!);
  return (
    parts.length === 2 &&
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    Object.keys(entry).some((name) => MCP_EXECUTION_KEYS.has(name))
  );
};

export function codexProfileConfig(
  resolved: ResolvedProviderSettings | undefined,
  mcpServers: Readonly<Record<string, ProfileMcpServerLaunch>> = {},
) {
  const value = resolved?._tag === "codex" ? resolved.settings : {};
  const config: Record<string, Schema.Json> = {};
  const refused: string[] = [];
  for (const [name, enabled] of Object.entries(value.features ?? {})) {
    const key = `features.${name}`;
    if (!/^[a-zA-Z0-9_]+$/.test(name) || codexProtectedKeys.some((owned) => overlaps(key, owned)))
      refused.push(key);
    else config[key] = enabled;
  }
  for (const [key, entry] of Object.entries(value.config ?? {})) {
    if (
      !/^[a-zA-Z0-9_.-]+$/.test(key) ||
      codexProtectedKeys.some((owned) => overlaps(key, owned)) ||
      key.startsWith("mcp_servers.t3-code") ||
      definesMcpCommand(key, entry)
    )
      refused.push(key);
    else config[key] = entry;
  }
  // Whole tables, so a same-named server from Codex's own config is replaced, not merged into.
  for (const [name, server] of Object.entries(mcpServers))
    config[`mcp_servers.${name}`] =
      server.type === "http"
        ? {
            url: server.url,
            ...(Object.keys(server.headers).length === 0 ? {} : { http_headers: server.headers }),
          }
        : {
            command: server.command,
            args: server.args,
            ...(Object.keys(server.env).length === 0 ? {} : { env: server.env }),
          };
  return {
    config,
    refused,
    unsupported: !!(value.disabledSkills?.length || value.disabledPlugins?.length),
  };
}
