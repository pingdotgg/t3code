import { createTranslator, type TranslateFn } from "@t3tools/client-runtime/i18n";
import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

/** Menus built outside React fall back to English; React callers pass `useT()`. */
const englishT: TranslateFn = createTranslator("en");

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
  readonly t?: TranslateFn;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  const t = options.t ?? englishT;
  return [
    {
      id: "copy",
      label: t("appB.threadMenu.copy"),
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath
          ? [{ id: "copy-path" as const, label: t("appB.threadMenu.path"), icon: "folder" }]
          : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: t("appB.threadMenu.branch"), icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [
          {
            id: "project-settings" as const,
            label: t("appB.threadMenu.projectSettings"),
            icon: "settings",
          },
        ]
      : []),
    {
      id: "discard",
      label: t("appB.threadMenu.discardDraft"),
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
  /** Translator for the menu labels; English when omitted. */
  readonly t?: TranslateFn;
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
  const t = state.t ?? englishT;
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.canFind
      ? [{ id: "find" as const, label: t("appB.threadMenu.find"), icon: "text-search" }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: t("appB.threadMenu.newOnBranch", { branch: state.branch }),
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: t("appB.threadMenu.unpin"), icon: "pin-off" }
            : { id: "pin" as const, label: t("appB.threadMenu.pin"), icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? {
                id: "unsettle" as const,
                label: t("appB.threadMenu.unsettle"),
                icon: "circle-check",
              }
            : { id: "settle" as const, label: t("appB.threadMenu.settle"), icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: t("appB.threadMenu.wake"), icon: "clock" }
            : {
                id: "snooze" as const,
                label: t("appB.threadMenu.snooze"),
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: t("appB.sidebar.bulk.snoozePreset", {
                      label: preset.label,
                      when: preset.whenLabel,
                    }),
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: t("appB.sidebar.bulk.custom"),
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    { id: "rename", label: t("appB.threadMenu.rename"), icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle
              ? t("appB.threadMenu.regenerating")
              : t("appB.threadMenu.regenerateTitle"),
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: t("appB.threadMenu.markUnread"), icon: "mail-open" },
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: t("appB.threadMenu.shareGuest"), icon: "user-plus" }]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? t("appB.threadMenu.showAllProjects")
              : t("appB.threadMenu.filterBy", { project: state.projectFilter.label }),
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: t("appB.threadMenu.turnIntoProject"),
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: t("appB.threadMenu.autoSettle"),
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: t("appB.threadMenu.enabled"),
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: t("appB.threadMenu.disabled"),
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: t("appB.threadMenu.copy"),
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: t("appB.threadMenu.path"), icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: t("appB.threadMenu.branch"), icon: "git-branch" }]
          : []),
        { id: "copy-thread", label: t("appB.threadMenu.thread"), icon: "message-square" },
        { id: "copy-thread-id", label: t("appB.threadMenu.threadId"), icon: "hash" },
      ],
    },
    { id: "project-settings", label: t("appB.threadMenu.projectSettings"), icon: "settings" },
    {
      id: "archive",
      label: t("appB.threadMenu.archive"),
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: t("appB.threadMenu.delete"),
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
