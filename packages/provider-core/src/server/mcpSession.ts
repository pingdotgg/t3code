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
   * Adapters read it to keep developer instructions truthful: when the user
   * withholds agent browser access, the prompt must not advertise `preview_*`
   * tools that every call would reject.
   */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /** Servers and skill switches from Settings → Tools; absent means none. */
  readonly tools?: McpProviderSessionTools;
  /**
   * Set while a web provider other than Built-in is selected in Settings →
   * Tools → Web. Adapters then ask the agent to use T3's `web_search` and
   * `web_fetch` first; its own web tools stay available as the fallback.
   */
  readonly webToolsPreferred?: boolean;
}

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
