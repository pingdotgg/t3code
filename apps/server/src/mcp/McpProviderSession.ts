import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

// Operator waits intentionally span complete child turns. Keep provider-side
// MCP call limits above realistic implementation runs while preserving normal
// cancellation when the coordinator turn is interrupted.
export const T3_MCP_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const T3_MCP_TOOL_TIMEOUT_SECONDS = T3_MCP_TOOL_TIMEOUT_MS / 1_000;

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
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

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
