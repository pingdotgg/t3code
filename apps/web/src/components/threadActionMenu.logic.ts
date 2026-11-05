import { t } from "@palamedes/core/macro";
import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

export type ThreadActionMenuId =
  | "find"
  | "new-thread-on-branch"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
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

export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: t({ message: "Copy" }),
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath
          ? [{ id: "copy-path" as const, label: t({ message: "Path" }), icon: "folder" }]
          : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: t({ message: "Branch" }), icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [
          {
            id: "project-settings" as const,
            label: t({ message: "Project settings" }),
            icon: "settings",
          },
        ]
      : []),
    {
      id: "discard",
      label: t({ message: "Discard draft" }),
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly canFind?: boolean;
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
}

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "find",
    "new-thread-on-branch",
    "project-settings",
    "mark-unread",
    "share-guest",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.canFind
      ? [{ id: "find" as const, label: t({ message: "Find in thread" }), icon: "text-search" }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: t`New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: t({ message: "Unpin thread" }), icon: "pin-off" }
            : { id: "pin" as const, label: t({ message: "Pin thread" }), icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? {
                id: "unsettle" as const,
                label: t({ message: "Un-settle thread" }),
                icon: "circle-check",
              }
            : {
                id: "settle" as const,
                label: t({ message: "Settle thread" }),
                icon: "circle-check",
              },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: t({ message: "Wake thread" }), icon: "clock" }
            : {
                id: "snooze" as const,
                label: t({ message: "Snooze" }),
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: t`${preset.label} (${preset.whenLabel})`,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: t({ message: "Custom…" }),
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    { id: "rename", label: t({ message: "Rename thread" }), icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle
              ? t({ message: "Regenerating…" })
              : t({ message: "Regenerate title" }),
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: t({ message: "Mark unread" }), icon: "mail-open" },
    ...(state.canShareWithGuest
      ? [
          {
            id: "share-guest" as const,
            label: t({ message: "Share with guest" }),
            icon: "user-plus",
          },
        ]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? t({ message: "Show all projects" })
              : t`Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: t({ message: "Turn into project" }),
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: t({ message: "Auto-settle behavior" }),
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: t({ message: "Enabled" }),
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: t({ message: "Disabled" }),
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: t({ message: "Copy" }),
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: t({ message: "Path" }), icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: t({ message: "Branch" }), icon: "git-branch" }]
          : []),
        { id: "copy-thread", label: t({ message: "Thread" }), icon: "message-square" },
        { id: "copy-thread-id", label: t({ message: "Thread ID" }), icon: "hash" },
      ],
    },
    { id: "project-settings", label: t({ message: "Project settings" }), icon: "settings" },
    {
      id: "archive",
      label: t({ message: "Archive thread" }),
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: t({ message: "Delete" }),
      destructive: true,
      icon: "trash",
    },
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
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
