import type { ContextMenuItem, TeamViewId } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

export type ThreadActionMenuId =
  | "find"
  | "new-thread-on-branch"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "follow"
  | "unfollow"
  | "team-view"
  | `team-view:${string}`
  | "team-lock"
  | "team-unlock"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "share-guest"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(
  options: {
    readonly hasPath: boolean;
    readonly hasBranch: boolean;
    readonly hasProject: boolean;
  },
  resolve: MessageResolver = m,
): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: resolve(msg("Copy", { $context: "submenu of things to copy" })),
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath
          ? [
              {
                id: "copy-path" as const,
                label: resolve(msg("Path", { $context: "copy the file path" })),
                icon: "folder",
              },
            ]
          : []),
        ...(options.hasBranch
          ? [
              {
                id: "copy-branch" as const,
                label: resolve(msg("Branch", { $context: "copy the git branch name" })),
                icon: "git-branch",
              },
            ]
          : []),
      ],
    },
    ...(options.hasProject
      ? [
          {
            id: "project-settings" as const,
            label: resolve(msg("Project settings")),
            icon: "settings",
          },
        ]
      : []),
    {
      id: "discard",
      label: resolve(msg("Discard draft")),
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  /** Settle, snooze and their undo stay available until the host denies the operate scope. */
  readonly canTriage?: boolean;
  readonly canTriageSnooze?: boolean;
  readonly canFind?: boolean;
  /** False where no inline title editor is rendered, such as sidebar search results. */
  readonly canRename?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  /** The server marks unread against the latest run's completion, so in-flight runs cannot be. */
  readonly hasCompletedRun: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
  /** Non-null only for colleagues' threads in an active team environment. */
  readonly teamFollow?: { readonly isFollowing: boolean } | null;
  /** Non-null when the actor can move this team thread between accessible views. */
  readonly teamView?: {
    readonly currentViewId: TeamViewId | null;
    readonly views: ReadonlyArray<{ readonly id: TeamViewId; readonly name: string }>;
  } | null;
  /** Non-null when the actor (owner/admin) can lock or unlock this team thread. */
  readonly teamLock?: { readonly isLocked: boolean } | null;
}

/** Local navigation, read markers, follow preferences, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  if (action.startsWith("team-view:")) return false;
  return ![
    "find",
    "new-thread-on-branch",
    "project-settings",
    "follow",
    "unfollow",
    "team-view",
    "team-lock",
    "team-unlock",
    "mark-unread",
    "share-guest",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

export function isThreadTriageAction(action: string): boolean {
  return (
    action === "settle" ||
    action === "unsettle" ||
    action === "snooze" ||
    action === "unsnooze" ||
    action.startsWith("snooze:")
  );
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
  resolve: MessageResolver = m,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.canFind
      ? [{ id: "find" as const, label: resolve(msg("Find in thread")), icon: "text-search" }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: resolve(msg("New thread on {branch}", { branch: state.branch })),
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.teamFollow
      ? [
          state.teamFollow.isFollowing
            ? {
                id: "unfollow" as const,
                label: resolve(msg("Unfollow thread")),
                icon: "bell-off",
              }
            : {
                id: "follow" as const,
                label: resolve(msg("Follow thread")),
                icon: "bell",
              },
        ]
      : []),
    ...(state.teamView && state.teamView.views.length > 0
      ? [
          {
            id: "team-view" as const,
            label: resolve(msg("Move to view")),
            icon: "layers",
            children: state.teamView.views.map((view) => ({
              id: `team-view:${view.id}` as const,
              label: view.name,
              checked: state.teamView?.currentViewId === view.id,
            })),
          },
        ]
      : []),
    ...(state.teamLock
      ? [
          state.teamLock.isLocked
            ? {
                id: "team-unlock" as const,
                label: resolve(msg("Unlock thread")),
                icon: "unlock",
              }
            : {
                id: "team-lock" as const,
                label: resolve(msg("Lock thread")),
                icon: "lock",
              },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: resolve(msg("Unpin thread")), icon: "pin-off" }
            : { id: "pin" as const, label: resolve(msg("Pin thread")), icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? {
                id: "unsettle" as const,
                label: resolve(msg("Un-settle thread")),
                icon: "circle-check",
              }
            : { id: "settle" as const, label: resolve(msg("Settle thread")), icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: resolve(msg("Wake thread")), icon: "clock" }
            : {
                id: "snooze" as const,
                label: resolve(msg("Snooze", { $context: "verb, snooze the thread" })),
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: preset.label,
                    detail: preset.whenLabel,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: resolve(msg("Custom…")),
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    {
      id: "rename",
      label: resolve(msg("Rename thread")),
      icon: "pencil",
      disabled: state.canRename === false,
      separatorBefore: true,
    },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle
              ? resolve(msg("Regenerating…"))
              : resolve(msg("Regenerate title")),
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    ...(state.hasCompletedRun && !state.isRunning
      ? [{ id: "mark-unread" as const, label: resolve(msg("Mark unread")), icon: "mail-open" }]
      : []),
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: resolve(msg("Share with guest")), icon: "user-plus" }]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? resolve(msg("Show all projects"))
              : resolve(msg("Filter by {project}", { project: state.projectFilter.label })),
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: resolve(msg("Turn into project")),
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: resolve(msg("Auto-settle behavior")),
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: resolve(msg("Follow settings")),
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: resolve(msg("Never", { $context: "auto-settle never" })),
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: resolve(msg("Copy", { $context: "submenu of things to copy" })),
      icon: "copy",
      separatorBefore: true,
      children: [
        {
          id: "copy-path",
          label: resolve(msg("Path", { $context: "copy the file path" })),
          icon: "folder",
        },
        ...(state.branch
          ? [
              {
                id: "copy-branch" as const,
                label: resolve(msg("Branch", { $context: "copy the git branch name" })),
                icon: "git-branch",
              },
            ]
          : []),
        {
          id: "copy-thread",
          label: resolve(msg("Thread", { $context: "copy the thread contents" })),
          icon: "message-square",
        },
        { id: "copy-thread-id", label: resolve(msg("Thread ID")), icon: "hash" },
      ],
    },
    { id: "project-settings", label: resolve(msg("Project settings")), icon: "settings" },
    {
      id: "archive",
      label: resolve(msg("Archive thread")),
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: resolve(msg("Delete", { $context: "verb, delete the thread" })),
      destructive: true,
      icon: "trash",
    },
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id) &&
        !(state.canTriage === true && isThreadTriageAction(item.id)) &&
        !(state.canTriageSnooze === true && (item.id === "snooze" || item.id === "unsnooze"))
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}
