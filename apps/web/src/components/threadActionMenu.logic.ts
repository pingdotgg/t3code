import { type ContextMenuItem, ThreadTag } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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
  | "folder"
  | `folder:${string}`
  | "folder-new"
  | "folder-none"
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
      label: "Copy",
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
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
  /** Folders are thread tags; null hides the Folder submenu. */
  readonly folders?: ThreadFolderMenuState | null;
}

export interface ThreadFolderMenuState {
  /** Every folder the client knows, sorted by name. */
  readonly names: ReadonlyArray<string>;
  /** The current tags of each thread the menu acts on. */
  readonly threadTags: ReadonlyArray<ReadonlyArray<string>>;
}

export interface ThreadFolderTagChange {
  readonly tag: string;
  readonly tagged: boolean;
}

/** Adds the folder before removing other tags, so a partial failure never drops the thread back to its project. */
export function folderTagChanges(
  currentTags: ReadonlyArray<string>,
  folder: string | null,
): ReadonlyArray<ThreadFolderTagChange> {
  const removals = currentTags
    .filter((tag) => tag !== folder)
    .map((tag) => ({ tag, tagged: false }));
  return folder === null || currentTags.includes(folder)
    ? removals
    : [{ tag: folder, tagged: true }, ...removals];
}

export function threadFolderNames(
  threads: Iterable<{ readonly tags?: ReadonlyArray<string> | undefined }>,
): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const thread of threads) {
    for (const tag of thread.tags ?? []) names.add(tag);
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

const isThreadTag = Schema.is(ThreadTag);

/** The trimmed folder name, or null when it is not a valid thread tag. */
export function parseFolderName(input: string): string | null {
  const name = input.trim();
  return isThreadTag(name) ? name : null;
}

/** The target folder of a Folder submenu action (null for Back to project), or undefined for other actions. */
export function folderFromMenuAction(action: string): string | null | undefined {
  if (action === "folder-none") return null;
  return action.startsWith("folder:") ? action.slice("folder:".length) : undefined;
}

export function isFolderMenuAction(action: string): boolean {
  return action === "folder-new" || folderFromMenuAction(action) !== undefined;
}

export function buildFolderMenuItem(
  folders: ThreadFolderMenuState,
): ContextMenuItem<ThreadActionMenuId> {
  const everyThread = (predicate: (tags: ReadonlyArray<string>) => boolean) =>
    folders.threadTags.every(predicate);
  return {
    id: "folder",
    label: "Folder",
    icon: "folder",
    children: [
      ...folders.names.map((name) => ({
        id: `folder:${name}` as const,
        label: name,
        checked: everyThread((tags) => tags.includes(name)),
        disabled: everyThread((tags) => folderTagChanges(tags, name).length === 0),
      })),
      {
        id: "folder-new" as const,
        label: "New folder…",
        icon: "folder-plus",
        separatorBefore: folders.names.length > 0,
      },
      {
        id: "folder-none" as const,
        label: "Back to project",
        disabled: everyThread((tags) => tags.length === 0),
      },
    ],
  };
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
      ? [{ id: "find" as const, label: "Find in thread", icon: "text-search" }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
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
                    label: "Custom…",
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: "Share with guest", icon: "user-plus" }]
      : []),
    ...(state.folders ? [buildFolderMenuItem(state.folders)] : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: "Turn into project",
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-settle behavior",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Follow settings",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Never",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread", label: "Thread", icon: "message-square" },
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: "Delete",
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
