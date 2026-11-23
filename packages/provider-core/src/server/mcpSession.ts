import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * Sent by MCP clients that cannot defer tools themselves. The T3 MCP server then
 * lists only a core set plus `tool_search`, which lists the rest on demand.
 */
export const MCP_TOOL_EXPOSURE_HEADER = "t3-tool-exposure";
/** A shared MCP server as an agent session reaches it: through T3's proxy. */
export interface SharedMcpSessionServer {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The session entries for `pluginIds`, each at `<endpoint>/shared/<id>` with the session's own
 * credential: agents reach plugins through T3 and never see their keys.
 */
export function sharedMcpSessionServers(
  plugins: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  session: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">,
): ReadonlyArray<SharedMcpSessionServer> {
  return plugins.map((plugin) => ({
    name: plugin.name,
    url: `${session.endpoint}/shared/${encodeURIComponent(plugin.id)}`,
    headers: { Authorization: session.authorizationHeader },
  }));
}

/** What a thread's kind changes about its sessions. */
export type ThreadProfile = "developer" | "chat" | "coordinator" | "worker";

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
  /** True while a delegated task this thread started will wake it with its result. */
  readonly hasPendingWake?: Effect.Effect<boolean>;
  /** The thread's plugins, captured when the session is prepared. */
  readonly sharedServers?: ReadonlyArray<SharedMcpSessionServer>;
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
