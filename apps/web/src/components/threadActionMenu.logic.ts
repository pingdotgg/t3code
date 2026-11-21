import type { ContextMenuItem, RoadmapItemType, ThreadHighlightPalette } from "@lathe/contracts";
import type { SnoozePreset } from "@lathe/client-runtime/state/thread-settled";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";
// Fork: roadmap.
import { ROADMAP_TYPE_LABELS, ROADMAP_TYPES } from "./roadmap/roadmap.logic";

/**
 * Ids for the per-thread action menu. Snooze presets are dispatched as
 * `snooze:<presetId>` so the union stays closed while the preset list
 * remains data-driven. `snooze:custom` and `snooze:reminder` both open the
 * custom snooze dialog, the latter with its reminder field focused.
 */
export type ThreadActionMenuId =
  | "find"
  | "new-thread-on-branch"
  | "continue-in-new-thread"
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
  | "highlight"
  | "highlight:default"
  | `highlight:${number}`
  | "depends-on"
  | "new-thread-to-unblock"
  | "release"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "share-guest"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "copy-thread-chip"
  | "archive"
  | "delete"
  // Fork: roadmap. `roadmap-create:<type>` creates that type; `:new-thread` flips the toggle.
  | "roadmap-create"
  | `roadmap-create:${RoadmapItemType | "new-thread"}`
  | "roadmap-attach"
  | "roadmap-detach";

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
  readonly canFind?: boolean;
  /** False where no inline title editor is rendered, such as sidebar search results. */
  readonly canRename?: boolean;
  readonly branch: string | null;
  /**
   * The project lets agents read thread history, so a new thread can pick up
   * this one by reference. False for unsent drafts, which have nothing to read.
   */
  readonly canContinueInNewThread: boolean;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  /** Current highlight color, or null for the plain card. */
  readonly highlightColor: string | null;
  /** Palette offered under Highlight; each index dispatches as `highlight:<index>`. */
  readonly highlightPalette: ThreadHighlightPalette;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  /** Pending snooze reminder; labels the reminder entry on a snoozed thread. */
  readonly snoozeReminder: string | null;
  readonly canSnoozeNow: boolean;
  /** Waiting on another thread, so the only parking action left is the way out. */
  readonly isBlocked: boolean;
  readonly canAddDependencyNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    /** Server accepts a reminder on thread.snooze. */
    readonly snoozeReminder: boolean;
    readonly pinning: boolean;
    readonly highlight: boolean;
    readonly titleRegeneration: boolean;
    readonly dependencies: boolean;
    /** Fork: roadmap. The roadmap home serves a roadmap. */
    readonly roadmap?: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** Fork: roadmap. The thread's place on the roadmap, read from the roadmap home. */
  readonly roadmap?: ThreadActionMenuRoadmapState;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
}

// Fork: roadmap.
export interface ThreadActionMenuRoadmapState {
  /** The work item the thread is attached to, or null when it is on none. */
  readonly attachedTitle: string | null;
  /** The create submenu's "Start a new thread for it" toggle. */
  readonly createInNewThread: boolean;
  /**
   * The roadmap lives on the home, so its permission decides these entries,
   * not the thread environment's operate scope.
   */
  readonly canChange: boolean;
}

const ROADMAP_MENU_TITLE_MAX = 40;

// Fork: roadmap.
function roadmapMenuItems(
  state: ThreadActionMenuState,
  resolve: MessageResolver,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const roadmap = state.roadmap;
  if (state.supports.roadmap !== true || roadmap === undefined) return [];
  const disabled = !roadmap.canChange;
  const title = roadmap.attachedTitle;
  return [
    {
      id: "roadmap-create",
      label: resolve(msg("Create work item from thread")),
      icon: "plus",
      separatorBefore: true,
      disabled,
      children: [
        ...ROADMAP_TYPES.map((type) => ({
          id: `roadmap-create:${type}` as const,
          label: ROADMAP_TYPE_LABELS[type],
          disabled,
        })),
        {
          id: "roadmap-create:new-thread" as const,
          label: resolve(msg("Start a new thread for it")),
          checked: roadmap.createInNewThread,
          separatorBefore: true,
          disabled,
        },
      ],
    },
    title === null
      ? {
          id: "roadmap-attach",
          label: resolve(msg("Attach to work item…")),
          icon: "link",
          disabled,
        }
      : {
          id: "roadmap-detach",
          label: resolve(
            msg("Detach from {title}", {
              title:
                title.length > ROADMAP_MENU_TITLE_MAX
                  ? `${title.slice(0, ROADMAP_MENU_TITLE_MAX - 1)}…`
                  : title,
            }),
          ),
          icon: "unlink",
          disabled,
        },
  ];
}

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  // Fork: roadmap. Roadmap entries carry the home's permission instead.
  if (action.startsWith("roadmap-")) return false;
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
    "copy-thread-chip",
  ].includes(action);
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
    ...(state.canContinueInNewThread
      ? [
          {
            id: "continue-in-new-thread" as const,
            label: resolve(msg("Continue in new thread")),
            icon: "link",
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
    // A highlight is a visual marker only: it survives settle, snooze, and
    // pin changes. The checked entry mirrors what the card shows now.
    ...(state.supports.highlight
      ? [
          {
            id: "highlight" as const,
            label: resolve(msg("Highlight", { $context: "submenu of thread highlight colors" })),
            icon: "palette",
            children: [
              {
                id: "highlight:default" as const,
                label:
                  state.highlightColor === null
                    ? resolve(msg("Default ✓", { $context: "highlight color, selected" }))
                    : resolve(msg("Default", { $context: "highlight color" })),
              },
              ...state.highlightPalette.map((entry, index) => ({
                id: `highlight:${index}` as const,
                label:
                  state.highlightColor !== null &&
                  entry.color.trim().toLowerCase() === state.highlightColor.trim().toLowerCase()
                    ? `${entry.label} ✓`
                    : entry.label,
                ...(index === 0 ? { separatorBefore: true } : {}),
              })),
            ],
          },
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
    // A thread waits either for a time or for other threads, never both, so
    // the parking group shows one set at a time: the way out while it waits,
    // otherwise snooze beside the two ways to park it on another thread.
    ...(state.supports.dependencies && state.isBlocked
      ? [{ id: "release" as const, label: resolve(msg("Wake thread")), icon: "clock" }]
      : [
          ...(state.supports.snooze
            ? state.isSnoozed
              ? [
                  { id: "unsnooze" as const, label: resolve(msg("Wake thread")), icon: "clock" },
                  // The snooze submenu is gone while snoozed, so the note
                  // stays editable and removable from here.
                  ...(state.supports.snoozeReminder
                    ? [
                        {
                          id: "snooze:reminder" as const,
                          label: state.snoozeReminder
                            ? resolve(msg("Edit reminder…"))
                            : resolve(msg("Add reminder…")),
                          icon: "pencil",
                        },
                      ]
                    : []),
                ]
              : [
                  {
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
                      ...(state.supports.snoozeReminder
                        ? [
                            {
                              id: "snooze:reminder" as const,
                              label: resolve(msg("Snooze with reminder…")),
                            },
                          ]
                        : []),
                    ],
                  },
                ]
            : []),
          // Disabled rather than hidden for the same reason as snooze: the
          // thread is asking the user something, and hiding the item would
          // read as the feature being unavailable here.
          ...(state.supports.dependencies
            ? [
                {
                  id: "depends-on" as const,
                  label: resolve(msg("Depends on…")),
                  icon: "link",
                  disabled: !state.canAddDependencyNow,
                },
                {
                  id: "new-thread-to-unblock" as const,
                  label: resolve(msg("Start a thread to unblock this")),
                  icon: "message-square-plus",
                  disabled: !state.canAddDependencyNow,
                },
              ]
            : []),
        ]),
    // Fork: roadmap.
    ...roadmapMenuItems(state, resolve),
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
    { id: "mark-unread", label: resolve(msg("Mark unread")), icon: "mail-open" },
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
        { id: "copy-thread-chip", label: resolve(msg("Thread chip")), icon: "link" },
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
