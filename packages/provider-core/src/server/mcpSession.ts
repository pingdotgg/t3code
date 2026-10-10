import type {
  EnvironmentId,
  ProviderInstanceId,
  ResolvedMcpServer,
  ThreadId,
} from "@t3tools/contracts";

/**
 * The user's tools for one thread, resolved from Settings → Tools when the
 * session is prepared. Adapters add the servers next to `t3-code` and hide
 * the skills where their provider can.
 */
export interface McpProviderSessionTools {
  /** Enabled servers with secrets materialized, sorted by name. */
  readonly servers: ReadonlyArray<ResolvedMcpServer>;
  /** Skill names hidden from the agent, sorted. */
  readonly disabledSkills: ReadonlyArray<string>;
  /**
   * Changes whenever `servers` or `disabledSkills` do, without exposing a
   * secret. Adapters compare it to decide when a live process is stale.
   */
  readonly fingerprint: string;
}

export const EMPTY_MCP_PROVIDER_SESSION_TOOLS: McpProviderSessionTools = {
  servers: [],
  disabledSkills: [],
  fingerprint: "",
};

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
  /** Servers and skill switches from Settings → Tools; absent means none. */
  readonly tools?: McpProviderSessionTools;
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
