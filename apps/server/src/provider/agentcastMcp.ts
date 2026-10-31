import type * as Schema from "effect/Schema";

/**
 * agentcast gives agents remote Windows desktops (UI trees, background input, a lock gate and
 * an action journal) through a stdio MCP server, `agentcast mcp`. When
 * `T3CODE_AGENTCAST_MAIN` points at its built CLI (`@agentcast/cli` `dist/main.js`), provider
 * sessions get it beside `t3-code`. Hosts come from `~/.config/agentcast/hosts.json`.
 */
export const AGENTCAST_MCP_SERVER = "agentcast";

/** Read-only agentcast tools, for read-only sandboxes. */
export const AGENTCAST_READ_ONLY_TOOLS = [
  "hosts",
  "health",
  "apps",
  "windows",
  "read",
  "zoom",
  "screen",
  "verify",
  "op_status",
] as const;

export interface AgentcastStdioServer {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

// MCP stdio clients start servers with a short default environment. agentcast needs the ssh
// agent socket for its SSH keys, and its own host settings.
const PASSED_THROUGH = ["SSH_AUTH_SOCK", "AGENTCAST_HOSTS", "AGENTCAST_HOSTS_JSON"] as const;

/**
 * The stdio command for one thread, or undefined when agentcast is not configured.
 * `AGENTCAST_CLIENT` names the thread in each host's journal and gives it its own engine session.
 */
export function agentcastStdioServer(
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentcastStdioServer | undefined {
  // The opt-in switch. Set it only on machines with agentcast hosts: the tool list costs about
  // 9k tokens in every session.
  const main = env.T3CODE_AGENTCAST_MAIN;
  if (!main) return undefined;
  const passed = Object.fromEntries(
    PASSED_THROUGH.flatMap((name) => (env[name] ? [[name, env[name]]] : [])),
  );
  return {
    command: process.execPath,
    args: [main, "mcp"],
    env: {
      ...passed,
      AGENTCAST_CLIENT: `t3:${threadId}`,
      // Inside the packaged app, process.execPath is Electron: run it as Node.
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  };
}

/**
 * Codex approval settings for agentcast. Read-only sandbox: only read-only tools exist (Codex runs
 * a "prompt" tool unasked under `on-request`). Full-access: all approved. Otherwise: read-only
 * tools approved, the rest "prompt", which Codex asks for under `untrusted`.
 */
export function agentcastCodexApprovals(
  runtimePolicy: { readonly runtimeMode: string; readonly sandboxPolicy?: unknown } | undefined,
): Record<string, Schema.Json> {
  const sandbox = runtimePolicy?.sandboxPolicy;
  const readOnlySandbox =
    typeof sandbox === "object" &&
    sandbox !== null &&
    "type" in sandbox &&
    sandbox.type === "readOnly";
  const readOnly = Object.fromEntries(
    AGENTCAST_READ_ONLY_TOOLS.map((tool) => [tool, { approval_mode: "approve" }]),
  );
  if (readOnlySandbox) {
    return {
      enabled_tools: [...AGENTCAST_READ_ONLY_TOOLS],
      default_tools_approval_mode: "prompt",
      tools: readOnly,
    };
  }
  if (runtimePolicy?.runtimeMode === "full-access") {
    return { default_tools_approval_mode: "approve" };
  }
  return { default_tools_approval_mode: "prompt", tools: readOnly };
}
