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
}

/** Server name every provider sees for the managed Cua Driver. */
export const CUA_MCP_SERVER_NAME = "cua-driver";

const cuaEnvironment = (descriptor: CuaDriverMcpConfiguration) =>
  Object.fromEntries(descriptor.environment.map(({ name, value }) => [name, value]));

/** Claude and Cursor SDK `mcpServers` entry for the session's Cua Driver, keyed by name. */
export function cuaStdioMcpServers(config: McpProviderSessionConfig | undefined) {
  const descriptor = config?.cuaDriver;
  return descriptor === undefined
    ? {}
    : {
        [CUA_MCP_SERVER_NAME]: {
          type: "stdio" as const,
          command: descriptor.command,
          args: [...descriptor.args],
          env: cuaEnvironment(descriptor),
        },
      };
}

/** ACP stdio `mcpServers` entry for the session's Cua Driver. */
export function cuaAcpMcpServers(config: McpProviderSessionConfig | undefined) {
  const descriptor = config?.cuaDriver;
  return descriptor === undefined
    ? []
    : [
        {
          name: CUA_MCP_SERVER_NAME,
          command: descriptor.command,
          args: [...descriptor.args],
          env: descriptor.environment.map(({ name, value }) => ({ name, value })),
        },
      ];
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
