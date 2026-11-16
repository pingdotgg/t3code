export * from "@t3tools/client-runtime/state/agents";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ContextMenuItem, McpGatewayProfile } from "@t3tools/contracts";
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

export type AgentThreadMenuId =
  | "move-up"
  | "move-down"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "detach-parent"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "archive"
  | "delete";

export function buildAgentThreadMenuItems(state: {
  readonly pinned: boolean;
  readonly settled: boolean;
  /** Children pin to the top of their parent and sort by status, so they never move by hand. */
  readonly isChildRow: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly isRegeneratingTitle: boolean;
  readonly hasParent: boolean;
  readonly hasWorkspacePath: boolean;
  readonly hasBranch: boolean;
}): ContextMenuItem<AgentThreadMenuId>[] {
  return [
    state.pinned
      ? { id: "unpin", label: "Unpin chat", icon: "pin-off" }
      : {
          id: "pin",
          label: state.isChildRow ? "Pin to top of parent" : "Pin chat to top",
          icon: "pin",
        },
    ...(!state.pinned && !state.settled && !state.isChildRow
      ? [
          {
            id: "move-up" as const,
            label: "Move up",
            icon: "arrow-up",
            disabled: !state.canMoveUp,
          },
          {
            id: "move-down" as const,
            label: "Move down",
            icon: "arrow-down",
            disabled: !state.canMoveDown,
          },
        ]
      : []),
    state.settled
      ? { id: "unsettle", label: "Un-settle chat", icon: "circle-check" }
      : { id: "settle", label: "Settle chat", icon: "circle-check" },
    { id: "rename", label: "Rename chat", icon: "pencil", separatorBefore: true },
    {
      id: "regenerate-title",
      label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
      icon: "refresh-cw",
      disabled: state.isRegeneratingTitle,
    },
    { id: "mark-unread", label: "Mark unread", icon: "mail-open", separatorBefore: true },
    ...(state.hasParent
      ? [{ id: "detach-parent" as const, label: "Remove from parent", icon: "unlink" }]
      : []),
    {
      id: "copy-path",
      label: "Copy path",
      icon: "folder",
      disabled: !state.hasWorkspacePath,
    },
    ...(state.hasBranch
      ? [{ id: "copy-branch" as const, label: "Copy branch", icon: "git-branch" }]
      : []),
    { id: "copy-thread-id", label: "Copy chat ID", icon: "hash" },
    { id: "archive", label: "Archive chat", icon: "archive", separatorBefore: true },
    { id: "delete", label: "Delete", destructive: true, icon: "trash" },
  ];
}
