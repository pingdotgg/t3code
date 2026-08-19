import {
  Bot,
  FileDiff,
  Files,
  GitBranch,
  GitPullRequest,
  Globe2,
  type LucideIcon,
  TerminalSquare,
} from "lucide-react";

export type AddPanelSurfaceId =
  | "source-control"
  | "browser"
  | "terminal"
  | "files"
  | "diff"
  | "pull-request"
  | "agents";

export type AddPanelSurfacePlacement = "empty-state" | "menu";
export type AddPanelSurfaceInstancePolicy = "singleton" | "multiple";

export interface AddPanelSurfaceActionProps {
  readonly onAddBrowser: () => void;
  readonly onAddTerminal: () => void;
  readonly onAddDiff: () => void;
  readonly onAddFiles: () => void;
  readonly onAddSourceControl: () => void;
  readonly onAddPullRequest: () => void;
  readonly onAddAgents: () => void;
  readonly browserAvailable: boolean;
  readonly terminalAvailable: boolean;
  readonly diffAvailable: boolean;
  readonly filesAvailable: boolean;
  readonly sourceControlAvailable: boolean;
  readonly pullRequestAvailable: boolean;
  readonly agentsAvailable: boolean;
  readonly liveAgentCount: number;
}

type AvailabilityKey = keyof Pick<
  AddPanelSurfaceActionProps,
  | "browserAvailable"
  | "terminalAvailable"
  | "diffAvailable"
  | "filesAvailable"
  | "sourceControlAvailable"
  | "pullRequestAvailable"
  | "agentsAvailable"
>;

type ActivationKey = keyof Pick<
  AddPanelSurfaceActionProps,
  | "onAddBrowser"
  | "onAddTerminal"
  | "onAddDiff"
  | "onAddFiles"
  | "onAddSourceControl"
  | "onAddPullRequest"
  | "onAddAgents"
>;

interface AddPanelSurfaceDescriptor {
  readonly id: AddPanelSurfaceId;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly shortcut: string;
  readonly availability: AvailabilityKey;
  readonly activation: ActivationKey;
  readonly instancePolicy: AddPanelSurfaceInstancePolicy;
  readonly order: Readonly<Record<AddPanelSurfacePlacement, number>>;
  readonly disabledReason: string;
  readonly unavailableHint: string;
  readonly badge: "live-agents" | null;
}

/**
 * Canonical policy for every addable right-panel surface. Both launchers,
 * their keyboard handlers, and focused tests consume actions built from this
 * table so Source Control's singleton and placement rules cannot drift while
 * multi-tab Pull Request and Browser behavior remains explicit.
 */
export const ADD_PANEL_SURFACE_DESCRIPTORS = [
  {
    id: "source-control",
    label: "Version Control",
    description: "Review repository changes and sync state.",
    icon: GitBranch,
    shortcut: "V",
    availability: "sourceControlAvailable",
    activation: "onAddSourceControl",
    instancePolicy: "singleton",
    order: { "empty-state": 0, menu: 6 },
    disabledReason: "Version Control is only available when a project is open in a Git repository.",
    unavailableHint: "Available for Git repositories.",
    badge: null,
  },
  {
    id: "browser",
    label: "Browser",
    description: "Open a local app or URL.",
    icon: Globe2,
    shortcut: "B",
    availability: "browserAvailable",
    activation: "onAddBrowser",
    instancePolicy: "multiple",
    order: { "empty-state": 1, menu: 0 },
    disabledReason: "Browser previews are only available in the T3 Code desktop app.",
    unavailableHint: "Only available in the desktop app.",
    badge: null,
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "Start a shell in this workspace.",
    icon: TerminalSquare,
    shortcut: "T",
    availability: "terminalAvailable",
    activation: "onAddTerminal",
    instancePolicy: "multiple",
    order: { "empty-state": 2, menu: 1 },
    disabledReason: "Terminal surfaces are only available from a project thread.",
    unavailableHint: "Available when a project is open.",
    badge: null,
  },
  {
    id: "files",
    label: "Files",
    description: "Browse and read workspace files.",
    icon: Files,
    shortcut: "F",
    availability: "filesAvailable",
    activation: "onAddFiles",
    instancePolicy: "singleton",
    order: { "empty-state": 3, menu: 2 },
    disabledReason: "Files are only available when a project is open.",
    unavailableHint: "Available when a project is open.",
    badge: null,
  },
  {
    id: "diff",
    label: "Diff",
    description: "Review changes in this thread.",
    icon: FileDiff,
    shortcut: "D",
    availability: "diffAvailable",
    activation: "onAddDiff",
    instancePolicy: "singleton",
    order: { "empty-state": 4, menu: 3 },
    disabledReason: "Diff is only available for server threads in Git repositories.",
    unavailableHint: "Available for Git repositories.",
    badge: null,
  },
  {
    id: "pull-request",
    label: "Pull request",
    description: "Open this branch's pull request.",
    icon: GitPullRequest,
    shortcut: "P",
    availability: "pullRequestAvailable",
    activation: "onAddPullRequest",
    instancePolicy: "multiple",
    order: { "empty-state": 5, menu: 4 },
    disabledReason: "This thread's branch has no pull request yet.",
    unavailableHint: "No pull request on this branch yet.",
    badge: null,
  },
  {
    id: "agents",
    label: "Agents",
    description: "Watch subagents and workflows run.",
    icon: Bot,
    shortcut: "A",
    availability: "agentsAvailable",
    activation: "onAddAgents",
    instancePolicy: "singleton",
    order: { "empty-state": 6, menu: 5 },
    disabledReason: "Agents are only available from a thread.",
    unavailableHint: "Available from a thread.",
    badge: "live-agents",
  },
] as const satisfies readonly AddPanelSurfaceDescriptor[];

export interface AddPanelSurfaceAction {
  readonly id: AddPanelSurfaceId;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly shortcut: string;
  readonly instancePolicy: AddPanelSurfaceInstancePolicy;
  readonly available: boolean;
  readonly disabledReason: string;
  readonly unavailableHint: string;
  readonly onClick: () => void;
  readonly badgeCount: number;
}

export function buildAddSurfaceActions(
  props: AddPanelSurfaceActionProps,
  placement: AddPanelSurfacePlacement = "empty-state",
): readonly AddPanelSurfaceAction[] {
  return ADD_PANEL_SURFACE_DESCRIPTORS.map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
    description: descriptor.description,
    icon: descriptor.icon,
    shortcut: descriptor.shortcut,
    instancePolicy: descriptor.instancePolicy,
    available: props[descriptor.availability],
    disabledReason: descriptor.disabledReason,
    unavailableHint: descriptor.unavailableHint,
    onClick: props[descriptor.activation],
    badgeCount: descriptor.badge === "live-agents" ? props.liveAgentCount : 0,
    order: descriptor.order[placement],
  }))
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...action }) => action);
}

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
>;

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return (
    actions.find(
      (action) => action.available && action.shortcut.toLowerCase() === event.key.toLowerCase(),
    ) ?? null
  );
}
