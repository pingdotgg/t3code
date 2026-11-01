export * from "@t3tools/client-runtime/state/agents";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { McpGatewayProfile } from "@t3tools/contracts";

/** A run's agent as the board names it: its profile, else its snapshot name, else "Chat". */
export function runAgentName(
  run: EnvironmentThreadShell,
  profiles: readonly McpGatewayProfile[] | undefined,
) {
  const profile = profiles?.find(
    (candidate) => candidate.profileId === run.profileSnapshot?.profileId,
  );
  return {
    profile,
    name: profile?.name ?? run.profileSnapshot?.profileName ?? "Chat",
  };
}

/**
 * Opens a run's menu. Children pass their siblings: they pin to the top of
 * their parent and, sorted by status, offer no Move up/down.
 */
export type AgentRunContextMenu = (
  thread: EnvironmentThreadShell,
  position: { x: number; y: number },
  siblings?: readonly EnvironmentThreadShell[],
) => Promise<void>;
