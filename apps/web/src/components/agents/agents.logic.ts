export * from "@t3tools/client-runtime/state/agents";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { McpGatewayProfile } from "@t3tools/contracts";
import { agentColorFor, agentColors } from "@t3tools/client-runtime/state/agents";

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

/** The `--agent-color` a run's agent draws with: the board's palette color, or muted for a removed agent. */
export function agentAccentColor(
  profile: McpGatewayProfile | undefined,
  profiles: readonly McpGatewayProfile[] | undefined,
) {
  return profile ? agentColorFor(profile, profiles ?? [profile]) : "var(--muted-foreground)";
}

/** The swatch a new or uncolored agent gets: the palette slot for its place in the list. */
export function defaultAgentColor(
  profile: Pick<McpGatewayProfile, "profileId"> | null,
  profiles: ReadonlyArray<Pick<McpGatewayProfile, "profileId">>,
) {
  const index = profile
    ? profiles.findIndex((item) => item.profileId === profile.profileId)
    : profiles.length;
  return agentColors[Math.max(0, index) % agentColors.length]!;
}

/** The only option when there is exactly one, so a form can preselect it. */
export function soleOption<T>(options: ReadonlyArray<T>): T | undefined {
  return options.length === 1 ? options[0] : undefined;
}
