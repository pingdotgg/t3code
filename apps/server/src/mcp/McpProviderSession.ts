import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type { LocalMcpServer } from "./ComputerAccess.ts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Whether this credential includes the "preview" capability. Adapters read
   * it to keep developer instructions truthful: when the user withholds agent
   * browser access, the prompt must not advertise `preview_*` tools that every
   * call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * Opt-in stdio servers (Cua Driver, Chrome DevTools MCP), with their prompt
   * text. Adapters that run stdio MCP servers attach them next to `t3-code`
   * and pass them to `buildRuntimeInstructions`; Codex keeps its own Computer
   * Use, and OpenCode 2 and Pi do not attach them yet.
   */
  readonly localMcpServers?: ReadonlyArray<LocalMcpServer>;
}

/** Claude and Cursor SDK `mcpServers` entries for the session's local servers. */
export function stdioLocalMcpServers(config: McpProviderSessionConfig | undefined) {
  return Object.fromEntries(
    (config?.localMcpServers ?? []).map((server) => [
      server.name,
      {
        type: "stdio" as const,
        command: server.command,
        args: [...server.args],
        env: { ...server.env },
      },
    ]),
  );
}

/** ACP stdio `mcpServers` entries for the session's local servers. */
export function acpLocalMcpServers(config: McpProviderSessionConfig | undefined) {
  return (config?.localMcpServers ?? []).map((server) => ({
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  }));
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
