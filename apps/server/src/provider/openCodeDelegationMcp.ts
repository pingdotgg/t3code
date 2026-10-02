import type { ModelSelection, ProviderInstanceId, RuntimeMode } from "@t3tools/contracts";

import type { McpServeOptions } from "../mcpServer.ts";

/**
 * T3-tools toolsets exposed to OpenCode sessions for delegation.
 *
 * Mirrors the Copilot ACP delegation surface without overlapping the tools
 * OpenCode already gets natively or via the `t3-code` provider MCP server
 * (preview, terminal, acceptance, PR-monitor, device). File tools are
 * intentionally omitted: OpenCode has native read/write/bash.
 */
export const OPENCODE_DELEGATION_TOOLSETS = [
  "delegate_work",
  "create_nested_thread",
  "create_nested_threads",
  "send_to_thread",
  "report_to_parent",
  "assign_to_thread",
  "set_child_wait",
  "create_isolated_workspace",
  "switch_workspace",
  "associate_pull_request",
  "link_pull_request",
  "unlink_pull_request",
  "list_thread_pull_requests",
] as const;

export function buildOpenCodeDelegationMcpOptions(input: {
  readonly cwd: string;
  readonly threadId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeMode?: RuntimeMode;
  readonly cliBaseDir?: string;
  readonly delegatedDefaultModelSelection?: ModelSelection;
  readonly env?: NodeJS.ProcessEnv;
  readonly runtime?: {
    readonly execPath: string;
    readonly entryPath: string | undefined;
  };
}): McpServeOptions {
  const env = input.env ?? process.env;
  const configuredCommand = env.T3_OPENCODE_MCP_COMMAND?.trim() || undefined;
  const runtime = input.runtime ?? {
    execPath: process.execPath,
    entryPath: process.argv[1],
  };
  const commandArgsPrefix =
    configuredCommand === undefined && runtime.entryPath !== undefined ? [runtime.entryPath] : [];
  const command = configuredCommand ?? (commandArgsPrefix.length > 0 ? runtime.execPath : "t3");
  return {
    cwd: input.cwd,
    toolsets: new Set<string>([...OPENCODE_DELEGATION_TOOLSETS]),
    threadId: input.threadId,
    cliCommand: command,
    providerInstanceId: input.providerInstanceId,
    ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
    ...(commandArgsPrefix.length > 0 ? { cliArgsPrefix: commandArgsPrefix } : {}),
    ...(input.cliBaseDir ? { cliBaseDir: input.cliBaseDir } : {}),
    ...(input.delegatedDefaultModelSelection
      ? { delegatedDefaultModelSelection: input.delegatedDefaultModelSelection }
      : {}),
  };
}
