import type {
  EnvironmentId,
  ProviderInstanceId,
  ResolvedMcpServer,
  ThreadId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * Sent by MCP clients that cannot defer tools themselves. The T3 MCP server then
 * lists only a core set plus `tool_search`, which lists the rest on demand.
 */
export const MCP_TOOL_EXPOSURE_HEADER = "t3-tool-exposure";

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

/**
 * A user-configured MCP server, reached through T3 Code's forwarding route
 * with the same `authorizationHeader` as `t3-code`. The upstream credential
 * stays on the server and never appears here.
 */
export interface McpUpstreamServerEntry {
  /** A unique lowercase slug that never collides with `t3-code`. */
  readonly name: string;
  readonly endpoint: string;
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Omit preview_* instructions when the user withholds agent browser access. */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  readonly upstreamServers?: ReadonlyArray<McpUpstreamServerEntry>;
  /** Servers and skill switches from Settings → Tools; absent means none. */
  readonly tools?: McpProviderSessionTools;
  /** True while a delegated task this thread started will wake it with its result. */
  readonly hasPendingWake?: Effect.Effect<boolean>;
}

const isReadOnlySandbox = (sandboxPolicy: unknown): boolean =>
  typeof sandboxPolicy === "object" &&
  sandboxPolicy !== null &&
  "type" in sandboxPolicy &&
  sandboxPolicy.type === "readOnly";

/**
 * Upstream tools can write anywhere the user's accounts reach, which a
 * read-only sandbox cannot police, so read-only sessions get none.
 */
export function upstreamServersFor(
  config: Pick<McpProviderSessionConfig, "upstreamServers"> | undefined,
  runtimePolicy: { readonly sandboxPolicy?: unknown } | undefined,
): ReadonlyArray<McpUpstreamServerEntry> {
  if (isReadOnlySandbox(runtimePolicy?.sandboxPolicy)) return [];
  return config?.upstreamServers ?? [];
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
