import type { ProjectIconOverride } from "@t3tools/contracts";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import {
  folderScopeKey,
  folderTagOfScopeKey,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey } from "../../uiStateStore";
import { orderItemsByPreferredIds, resolveSidebarFolderDot } from "../Sidebar.logic";
import type { ThreadFolderTagChange } from "../threadActionMenu.logic";

export type ProjectRailDot = ReturnType<typeof resolveSidebarFolderDot>;

type RailGroup = Pick<
  SidebarProjectSnapshot,
  "projectKey" | "memberProjects" | "memberProjectRefs"
>;

type RailThread = Parameters<typeof resolveSidebarFolderDot>[0][number] &
  Pick<
    EnvironmentThreadShell,
    "environmentId" | "projectId" | "pinnedAt" | "settledOverride" | "snoozedUntil" | "tags"
  >;

export type ProjectRailTile<TGroup extends RailGroup = SidebarProjectSnapshot> =
  | { readonly kind: "project"; readonly key: string; readonly group: TGroup }
  | { readonly kind: "folder"; readonly key: string; readonly tag: string };

/**
 * Project tiles in the manual project order, then a folder tile per tag, then
 * the rail's own order over both, so a tile stays where it was dragged whatever
 * the sidebar sort is. Tiles the rail order never saw keep their place after it.
 */
export function buildProjectRailTiles<TGroup extends RailGroup>(input: {
  readonly groups: readonly TGroup[];
  readonly threads: readonly Pick<RailThread, "tags">[];
  /** A chosen folder keeps its tile while no thread carries its tag, so it can be unchosen. */
  readonly selectedKeys: readonly string[];
  readonly projectOrder: readonly string[];
  readonly railOrder: readonly string[];
}): ProjectRailTile<TGroup>[] {
  const projectTiles = orderItemsByPreferredIds({
    items: input.groups,
    preferredIds: input.projectOrder,
    getId: (group) => group.projectKey,
    getPreferenceIds: (group) => [
      ...group.memberProjects.map((member) => member.physicalProjectKey),
      ...group.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
    ],
  }).map((group): ProjectRailTile<TGroup> => ({ kind: "project", key: group.projectKey, group }));
  const tags = [
    ...new Set([
      ...input.threads.flatMap((thread) => thread.tags ?? []),
      ...input.selectedKeys.flatMap((key) => folderTagOfScopeKey(key) ?? []),
    ]),
  ].toSorted((left, right) => left.localeCompare(right));
  const folderTiles = tags.map((tag): ProjectRailTile<TGroup> => ({
    kind: "folder",
    key: folderScopeKey(tag),
    tag,
  }));
  return orderItemsByPreferredIds({
    items: [...projectTiles, ...folderTiles],
    preferredIds: input.railOrder,
    getId: (tile) => tile.key,
  });
}

/**
 * The rail order and the manual project order after `activeKey` is dropped
 * onto `overKey`'s place. The project order follows so the rest of the app
 * keeps reading the same order of projects.
 */
export function railOrderAfterMove(
  tiles: readonly ProjectRailTile<RailGroup>[],
  activeKey: string,
  overKey: string,
): { readonly railOrder: string[]; readonly projectOrder: string[] } | null {
  const from = tiles.findIndex((tile) => tile.key === activeKey);
  const to = tiles.findIndex((tile) => tile.key === overKey);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...tiles];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return {
    railOrder: next.map((tile) => tile.key),
    projectOrder: next.flatMap((tile) =>
      tile.kind === "project"
        ? tile.group.memberProjects.map((member) => member.physicalProjectKey)
        : [],
    ),
  };
}

/**
 * A plain click shows only that tile, or every tile when it was already
 * the only one shown. An additive click adds or removes it.
 */
export function nextProjectRailScope(
  current: readonly string[],
  key: string,
  additive: boolean,
): string[] {
  if (additive) {
    return current.includes(key)
      ? current.filter((candidate) => candidate !== key)
      : [...current, key];
  }
  return current.length === 1 && current[0] === key ? [] : [key];
}

export interface ProjectRailTileState {
  readonly dot: ProjectRailDot;
  /** No thread outside the settled and snoozed shelves, and nothing to show on the dot. */
  readonly idle: boolean;
}

/** A project tile holds its untagged threads; a folder tile holds every thread with its tag. */
export function resolveProjectRailTileStates(
  tiles: readonly ProjectRailTile<RailGroup>[],
  threads: readonly RailThread[],
  now: string,
): Map<string, ProjectRailTileState> {
  const tileKeyByProject = new Map<string, string>();
  for (const tile of tiles) {
    if (tile.kind !== "project") continue;
    for (const ref of tile.group.memberProjectRefs) {
      tileKeyByProject.set(`${ref.environmentId}:${ref.projectId}`, tile.key);
    }
  }
  const threadsByTile = new Map<string, RailThread[]>();
  const add = (key: string | undefined, thread: RailThread) => {
    if (key === undefined) return;
    const list = threadsByTile.get(key);
    if (list) list.push(thread);
    else threadsByTile.set(key, [thread]);
  };
  for (const thread of threads) {
    const tags = thread.tags ?? [];
    if (tags.length === 0) {
      add(tileKeyByProject.get(`${thread.environmentId}:${thread.projectId}`), thread);
    } else {
      for (const tag of tags) add(folderScopeKey(tag), thread);
    }
  }
  const states = new Map<string, ProjectRailTileState>();
  for (const tile of tiles) {
    const tileThreads = threadsByTile.get(tile.key) ?? [];
    const dot = resolveSidebarFolderDot(tileThreads);
    const live = tileThreads.some(
      (thread) =>
        thread.pinnedAt != null ||
        (thread.settledOverride !== "settled" && !effectiveSnoozed(thread, { now })),
    );
    states.set(tile.key, { dot, idle: dot === null && !live });
  }
  return states;
}

/**
 * The tag changes that rename folder `from` to `to`, or delete it when `to` is
 * null. A rename adds the new tag before removing the old one, so a thread that
 * fails halfway stays in a folder; renaming onto an existing folder merges into it.
 */
export function folderEditPlan<TThread extends Pick<RailThread, "tags">>(
  threads: readonly TThread[],
  from: string,
  to: string | null,
): { readonly thread: TThread; readonly changes: ReadonlyArray<ThreadFolderTagChange> }[] {
  if (from === to) return [];
  return threads.flatMap((thread) => {
    const tags = thread.tags ?? [];
    if (!tags.includes(from)) return [];
    const changes = [
      ...(to === null || tags.includes(to) ? [] : [{ tag: to, tagged: true }]),
      { tag: from, tagged: false },
    ];
    return [{ thread, changes }];
  });
}

/**
 * A folder edit: one server rename per environment in `renameEnvironmentIds`, which also reaches
 * threads this client has not loaded, and per-thread tag changes for loaded threads elsewhere.
 */
export function folderEditTargets<TThread extends Pick<RailThread, "tags" | "environmentId">>(
  threads: readonly TThread[],
  from: string,
  to: string | null,
  renameEnvironmentIds: ReadonlyArray<TThread["environmentId"]>,
) {
  if (from === to) return { environmentIds: [], plan: [] };
  return {
    environmentIds: renameEnvironmentIds,
    plan: folderEditPlan(
      threads.filter((thread) => !renameEnvironmentIds.includes(thread.environmentId)),
      from,
      to,
    ),
  };
}

/**
 * Rail order or scope keys with folder `from` renamed to `to` in place, or dropped when `to` is
 * null. A `from` that kept threads after a partial failure keeps its key, with `to` beside it.
 */
export function railKeysAfterFolderEdit(
  keys: readonly string[],
  from: string,
  to: string | null,
  fromSurvives = false,
): string[] {
  const fromKey = folderScopeKey(from);
  const toKey = to === null ? null : folderScopeKey(to);
  const next: string[] = [];
  const push = (key: string | null) => {
    if (key !== null && !next.includes(key)) next.push(key);
  };
  for (const key of keys) {
    if (key !== fromKey) push(key);
    else if (!fromSurvives) push(toKey);
    else {
      push(key);
      // A merge target keeps its own place.
      if (toKey !== null && !keys.includes(toKey)) push(toKey);
    }
  }
  return next;
}

/** Folder keys whose tag no live folder holds, dropped so a later folder of that name starts fresh. */
export function pruneStaleFolderKeys(
  keys: readonly string[],
  liveTags: ReadonlySet<string>,
): string[] {
  return keys.filter((key) => {
    const tag = folderTagOfScopeKey(key);
    return tag === null || liveTags.has(tag);
  });
}

/**
 * The `folderIcons` settings patch that moves folder `from`'s icon to `to`, or
 * drops it when `to` is null. A merge keeps the target folder's own icon, and
 * a `from` that kept some threads after a partial failure keeps its icon too.
 */
export function folderIconsPatchAfterEdit(
  icons: Readonly<Record<string, ProjectIconOverride>>,
  from: string,
  to: string | null,
  fromSurvives = false,
): Record<string, ProjectIconOverride | null> | null {
  const icon = icons[from];
  if (icon === undefined || from === to) return null;
  const patch: Record<string, ProjectIconOverride | null> = fromSurvives ? {} : { [from]: null };
  if (to !== null && icons[to] === undefined) patch[to] = icon;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** What "Filter by" on a thread picks: its folder when tagged, else its project unless archived. */
export function threadFilterTarget(
  thread: { readonly tags?: ReadonlyArray<string> | undefined },
  projectGroup: Pick<SidebarProjectSnapshot, "projectKey" | "displayName" | "archived"> | null,
  scopeKeys: readonly string[] = [],
): { readonly key: string; readonly label: string } | null {
  const tags = thread.tags ?? [];
  const tag = tags.find((candidate) => scopeKeys.includes(folderScopeKey(candidate))) ?? tags[0];
  if (tag !== undefined) return { key: folderScopeKey(tag), label: tag };
  if (projectGroup === null || projectGroup.archived) return null;
  return { key: projectGroup.projectKey, label: projectGroup.displayName };
}

/** A thread started while the sidebar shows exactly one folder, and nothing else, is born in it. */
export function newThreadCreateTags(scopeKeys: readonly string[]): {
  readonly tags?: readonly [string];
} {
  const tag = scopeKeys.length === 1 ? folderTagOfScopeKey(scopeKeys[0]!) : null;
  return tag === null ? {} : { tags: [tag] };
}
