import type {
  CuaDriverMcpConfiguration,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

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
   * Set when the environment's managed Cua Driver is running for this session.
   * Adapters attach it as a stdio MCP server named `cua-driver` and add the
   * computer use instructions; a provider without an MCP client ignores it.
   */
  readonly cuaDriver?: CuaDriverMcpConfiguration;
  /**
   * Set when browser tab access is on: Chrome DevTools MCP attached to the
   * user's running Chromium browser. Adapters attach it beside `cua-driver`.
   */
  readonly browserTabs?: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
    readonly browserName: string;
  };
}

/** Server name every provider sees for browser tab access. */
export const BROWSER_TABS_MCP_SERVER_NAME = "chrome-devtools";

/** Prompt text for a session with browser tab access. */
export const browserTabsInstructions = (browserName: string) =>
  `<browser_tabs>
The chrome-devtools MCP server is attached to the user's own ${browserName}, with their open tabs and signed-in sessions. Use it only when the user asks you to work in their browser or the task needs their existing sign-ins. For other web work, use the t3-code preview tools. The browser asks the user to allow each connection; if it cannot connect, ask them to turn on remote debugging in the browser's inspect page.
</browser_tabs>`;

/** The local stdio servers a session attaches, Cua Driver and browser tabs, as name-command pairs. */
function localStdioServers(config: McpProviderSessionConfig | undefined) {
  const servers: Array<{
    readonly name: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
  }> = [];
  if (config?.cuaDriver) {
    servers.push({
      name: CUA_MCP_SERVER_NAME,
      command: config.cuaDriver.command,
      args: config.cuaDriver.args,
      env: cuaEnvironment(config.cuaDriver),
    });
  }
  if (config?.browserTabs)
    servers.push({ name: BROWSER_TABS_MCP_SERVER_NAME, ...config.browserTabs });
  return servers;
}

/** Server name every provider sees for the managed Cua Driver. */
export const CUA_MCP_SERVER_NAME = "cua-driver";

const cuaEnvironment = (descriptor: CuaDriverMcpConfiguration) =>
  Object.fromEntries(descriptor.environment.map(({ name, value }) => [name, value]));

/** Claude and Cursor SDK `mcpServers` entries for the session's local servers, keyed by name. */
export function localStdioMcpServers(config: McpProviderSessionConfig | undefined) {
  return Object.fromEntries(
    localStdioServers(config).map((server) => [
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
export function localAcpMcpServers(config: McpProviderSessionConfig | undefined) {
  return localStdioServers(config).map((server) => ({
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  }));
}

/** OpenCode `local` MCP config for the session's Cua Driver. */
export function cuaOpenCodeMcpConfig(descriptor: CuaDriverMcpConfiguration) {
  return {
    type: "local" as const,
    command: [descriptor.command, ...descriptor.args],
    environment: cuaEnvironment(descriptor),
  };
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
