import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { splitThreadGroups } from "@t3tools/client-runtime/state/thread-groups";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

export type ThreadActionMenuId =
  | "find"
  | "new-thread-on-branch"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "pin"
  | "pin-project"
  | "unpin"
  | "attach-to-thread"
  | `attach-to-thread:${string}`
  | "detach-from-group"
  | "settle"
  | "settle-finished"
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

export interface ThreadActionMenuGroup {
  readonly role: "none" | "parent" | "worker";
  readonly attachCandidates: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly detail?: string;
  }>;
}

const NO_GROUP: ThreadActionMenuGroup = { role: "none", attachCandidates: [] };

const MAX_ATTACH_CANDIDATES = 30;

const shellKey = (shell: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id));

/** Shells carry no project title, so candidates from other projects have no `detail`. */
export function resolveThreadGroupMenuContext(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  thread: EnvironmentThreadShell,
): {
  group: ThreadActionMenuGroup;
  workers: ReadonlyArray<EnvironmentThreadShell>;
  attachTargets: ReadonlyArray<{ key: string; title: string; ref: ScopedThreadRef }>;
} {
  const threadKey = shellKey(thread);
  const { workersByParentKey } = splitThreadGroups(shells);
  const isWorker = [...workersByParentKey.values()].some((workers) =>
    workers.some((worker) => shellKey(worker) === threadKey),
  );
  const workers = workersByParentKey.get(threadKey) ?? [];
  const workerKeys = new Set(workers.map(shellKey));
  const attachTargets = shells
    .filter(
      (candidate) =>
        candidate.environmentId === thread.environmentId &&
        candidate.archivedAt == null &&
        shellKey(candidate) !== threadKey &&
        !workerKeys.has(shellKey(candidate)),
    )
    .toSorted(
      (left, right) =>
        Number(right.projectId === thread.projectId) -
          Number(left.projectId === thread.projectId) ||
        (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0),
    )
    .slice(0, MAX_ATTACH_CANDIDATES)
    .map((candidate) => ({
      key: shellKey(candidate),
      title: candidate.title,
      ref: scopeThreadRef(candidate.environmentId, candidate.id),
    }));
  return {
    group: {
      role: isWorker ? "worker" : workers.length > 0 ? "parent" : "none",
      attachCandidates: attachTargets.map(({ key, title }) => ({ key, title })),
    },
    workers,
    attachTargets,
  };
}

export function threadGroupArchiveConfirmDetail(
  workerCount: number,
  resolve: MessageResolver = m,
): string {
  return resolve(
    msg(
      "{count, plural, one {Its {count} group thread will show on its own until you unarchive it.} other {Its {count} group threads will show on their own until you unarchive it.}}",
      { count: workerCount },
    ),
  );
}

export function threadGroupDeleteConfirmDetail(
  workerCount: number,
  resolve: MessageResolver = m,
): string {
  return resolve(
    msg(
      "{count, plural, one {Its {count} group thread will stay as a regular thread.} other {Its {count} group threads will stay as regular threads.}}",
      { count: workerCount },
    ),
  );
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly canFind?: boolean;
  /** False where no inline title editor is rendered, such as sidebar search results. */
  readonly canRename?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isPinnedInProject: boolean;
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
  readonly group?: ThreadActionMenuGroup;
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
  resolve: MessageResolver = m,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const group = state.group ?? NO_GROUP;
  const isParent = group.role === "parent";
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
    ...(state.supports.pinning
      ? [
          ...(state.isPinned
            ? [{ id: "unpin" as const, label: resolve(msg("Unpin thread")), icon: "pin-off" }]
            : []),
          ...(group.role === "worker"
            ? []
            : [
                ...(!state.isPinned || state.isPinnedInProject
                  ? [
                      {
                        id: "pin" as const,
                        label: state.isPinned
                          ? resolve(msg("Pin above projects"))
                          : resolve(msg("Pin thread")),
                        icon: "pin",
                      },
                    ]
                  : []),
                ...(state.isPinnedInProject
                  ? []
                  : [
                      {
                        id: "pin-project" as const,
                        label: resolve(msg("Pin in project")),
                        icon: "pin",
                      },
                    ]),
              ]),
        ]
      : []),
    ...(group.role === "worker"
      ? [
          {
            id: "detach-from-group" as const,
            label: resolve(msg("Detach from group")),
            icon: "unlink",
          },
        ]
      : group.attachCandidates.length > 0
        ? [
            {
              id: "attach-to-thread" as const,
              label: resolve(msg("Attach to thread")),
              icon: "link-2",
              children: group.attachCandidates.map((candidate) => ({
                id: `attach-to-thread:${candidate.key}` as const,
                label: candidate.title,
                ...(candidate.detail === undefined ? {} : { detail: candidate.detail }),
              })),
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
            : isParent
              ? {
                  id: "settle" as const,
                  label: resolve(msg("Settle group")),
                  icon: "circle-check",
                  children: [
                    { id: "settle" as const, label: resolve(msg("Whole group")) },
                    {
                      id: "settle-finished" as const,
                      label: resolve(msg("Only finished threads")),
                    },
                  ],
                }
              : {
                  id: "settle" as const,
                  label: resolve(msg("Settle thread")),
                  icon: "circle-check",
                },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: resolve(msg("Wake thread")), icon: "clock" }
            : {
                id: "snooze" as const,
                label: isParent
                  ? resolve(msg("Snooze group"))
                  : resolve(msg("Snooze", { $context: "verb, snooze the thread" })),
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
