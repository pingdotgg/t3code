import { i18n } from "../i18nCore";
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
      label: i18n.t("sidebar:threads.copy"),
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath
          ? [
              {
                id: "copy-path" as const,
                label: i18n.t("sidebar:threads.copyPath"),
                icon: "folder",
              },
            ]
          : []),
        ...(options.hasBranch
          ? [
              {
                id: "copy-branch" as const,
                label: i18n.t("sidebar:threads.copyBranch"),
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
            label: i18n.t("sidebar:threads.projectSettings"),
            icon: "settings",
          },
        ]
      : []),
    {
      id: "discard",
      label: i18n.t("sidebar:actions.discardDraft"),
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
      ? [{ id: "find" as const, label: i18n.t("sidebar:threads.find"), icon: "text-search" }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: i18n.t("sidebar:threads.newOnBranch", { branch: state.branch }),
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: i18n.t("sidebar:threads.unpin"), icon: "pin-off" }
            : { id: "pin" as const, label: i18n.t("sidebar:threads.pin"), icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? {
                id: "unsettle" as const,
                label: i18n.t("sidebar:threads.unsettle"),
                icon: "circle-check",
              }
            : {
                id: "settle" as const,
                label: i18n.t("sidebar:threads.settle"),
                icon: "circle-check",
              },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: i18n.t("sidebar:threads.wake"), icon: "clock" }
            : {
                id: "snooze" as const,
                label: i18n.t("sidebar:threads.snooze"),
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
                    label: i18n.t("sidebar:threads.snoozeCustom"),
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    {
      id: "rename",
      label: i18n.t("sidebar:threads.rename"),
      icon: "pencil",
      separatorBefore: true,
    },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle
              ? i18n.t("sidebar:threads.regenerating")
              : i18n.t("sidebar:threads.regenerateTitle"),
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: i18n.t("sidebar:threads.markUnread"), icon: "mail-open" },
    ...(state.canShareWithGuest
      ? [
          {
            id: "share-guest" as const,
            label: i18n.t("sidebar:threads.shareWithGuest"),
            icon: "user-plus",
          },
        ]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? i18n.t("sidebar:threads.showAllProjects")
              : i18n.t("sidebar:threads.filterBy", { name: state.projectFilter.label }),
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: i18n.t("sidebar:threads.turnIntoProject"),
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: i18n.t("sidebar:threads.autoSettle"),
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: i18n.t("sidebar:threads.autoSettleFollowSettings"),
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: i18n.t("sidebar:threads.autoSettleNever"),
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: i18n.t("sidebar:threads.copy"),
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: i18n.t("sidebar:threads.copyPath"), icon: "folder" },
        ...(state.branch
          ? [
              {
                id: "copy-branch" as const,
                label: i18n.t("sidebar:threads.copyBranch"),
                icon: "git-branch",
              },
            ]
          : []),
        { id: "copy-thread", label: i18n.t("sidebar:threads.copyThread"), icon: "message-square" },
        { id: "copy-thread-id", label: i18n.t("sidebar:threads.copyThreadId"), icon: "hash" },
      ],
    },
    { id: "project-settings", label: i18n.t("sidebar:threads.projectSettings"), icon: "settings" },
    {
      id: "archive",
      label: i18n.t("sidebar:threads.archive"),
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: i18n.t("sidebar:threads.delete"),
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
