import {
  type EnvironmentId,
  type ProviderInstanceId,
  type SharedMcpServer,
  sharedMcpServerKey,
  type ThreadId,
} from "@t3tools/contracts";

/** A shared MCP server as an agent session reaches it: through T3's proxy. */
export interface SharedMcpSessionServer {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The session entries for `servers`, each at `<endpoint>/shared/<key>` with
 * the session's own credential.
 */
export function sharedMcpSessionServers(
  servers: ReadonlyArray<SharedMcpServer>,
  session: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">,
): ReadonlyArray<SharedMcpSessionServer> {
  return servers.map((server) => ({
    name: server.name,
    url: `${session.endpoint}/shared/${encodeURIComponent(sharedMcpServerKey(server))}`,
    headers: { Authorization: session.authorizationHeader },
  }));
}

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
   * The user's enabled shared MCP servers (Settings → Integrations), captured
   * when the session is prepared. Each points at T3's own proxy for that
   * server and carries this session's credential, so agents attach them next
   * to `t3-code` and never see the server's own headers or tokens.
   */
  readonly sharedServers?: ReadonlyArray<SharedMcpSessionServer>;
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
