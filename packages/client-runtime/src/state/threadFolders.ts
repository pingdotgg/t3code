import { Atom } from "effect/reactivity";
import type {
  EnvironmentId,
  ThreadFolder,
  ThreadFolderMutation,
  ThreadFolderRule,
  ThreadId,
} from "@t3tools/contracts";

export interface EnvironmentThreadFolder extends ThreadFolder {
  readonly environmentId: EnvironmentId;
}

export function scopedThreadFolderKey(folder: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
}): string {
  return `${folder.environmentId}:${folder.id}`;
}

export interface ThreadFolderBlock<T> {
  readonly folder: EnvironmentThreadFolder;
  readonly key: string;
  readonly threads: ReadonlyArray<T>;
}

/**
 * Splits `threads` into folder blocks, in folder order, and the threads no folder holds.
 * A folder keeps its place, so empty folders still render. Thread order inside a block is
 * the order of `threads`, so callers sort once.
 */
export function layoutThreadFolders<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly folders: ReadonlyArray<EnvironmentThreadFolder>;
}): { readonly blocks: ReadonlyArray<ThreadFolderBlock<T>>; readonly unfiled: ReadonlyArray<T> } {
  const folderKeyByThreadKey = new Map<string, string>();
  for (const folder of input.folders) {
    const folderKey = scopedThreadFolderKey(folder);
    for (const threadId of folder.threadIds) {
      folderKeyByThreadKey.set(`${folder.environmentId}:${threadId}`, folderKey);
    }
  }
  const threadsByFolderKey = new Map<string, Array<T>>();
  const unfiled: Array<T> = [];
  for (const thread of input.threads) {
    const folderKey = folderKeyByThreadKey.get(`${thread.environmentId}:${thread.id}`);
    if (folderKey === undefined) {
      unfiled.push(thread);
      continue;
    }
    const list = threadsByFolderKey.get(folderKey) ?? [];
    list.push(thread);
    threadsByFolderKey.set(folderKey, list);
  }
  return {
    blocks: input.folders.map((folder) => {
      const key = scopedThreadFolderKey(folder);
      return { folder, key, threads: threadsByFolderKey.get(key) ?? [] };
    }),
    unfiled,
  };
}

/** The folder that holds a thread, if any. */
export function findThreadFolder(
  folders: ReadonlyArray<EnvironmentThreadFolder>,
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId },
): EnvironmentThreadFolder | null {
  return (
    folders.find(
      (folder) =>
        folder.environmentId === thread.environmentId && folder.threadIds.includes(thread.id),
    ) ?? null
  );
}

/**
 * Where a folder lands when dropped at `index` among `shown`, the folders of its section in
 * screen order, as the server's `beforeFolderId` over the stored `order`.
 */
export function resolveFolderReorder<Id>(
  order: readonly Id[],
  shown: readonly Id[],
  folderId: Id,
  index: number,
): { readonly beforeFolderId: Id | null } | null {
  const from = shown.indexOf(folderId);
  if (from === -1 || index === from || index === from + 1) return null;
  const before = shown[index];
  if (before !== undefined) return { beforeFolderId: before };
  const rest = order.filter((id) => id !== folderId);
  return { beforeFolderId: rest[rest.indexOf(shown.at(-1)!) + 1] ?? null };
}

/**
 * How a folder collects new threads, in the terms the folder menu offers. `custom` is a rule
 * an agent set with conditions the menu cannot show.
 */
export interface ThreadFolderCollect {
  readonly topic: boolean;
  readonly branches: ReadonlyArray<string>;
  readonly worktrees: ReadonlyArray<string>;
  readonly custom: boolean;
}

/** One click in the folder's Collect menu: Off, or one option to turn on or off. */
export type ThreadFolderCollectChoice =
  | { readonly by: "off" | "topic" }
  | { readonly by: "branch" | "worktree"; readonly value: string };

const COLLECT_OFF: ThreadFolderCollect = {
  topic: false,
  branches: [],
  worktrees: [],
  custom: false,
};

export function threadFolderCollect(
  folder: Pick<ThreadFolder, "rule" | "autoFile">,
): ThreadFolderCollect {
  if (folder.rule === null || !folder.autoFile) return COLLECT_OFF;
  const { smart, branches, worktrees, ...rest } = folder.rule;
  if (Object.values(rest).some((value) => value !== undefined)) {
    return { ...COLLECT_OFF, custom: true };
  }
  return {
    topic: smart === true,
    branches: branches ?? [],
    worktrees: worktrees ?? [],
    custom: false,
  };
}

/** The `folder.update` a Collect menu click makes, or null when nothing changes. */
export function threadFolderCollectUpdate(
  folder: Pick<ThreadFolder, "id" | "rule" | "autoFile">,
  choice: ThreadFolderCollectChoice,
): Extract<ThreadFolderMutation, { readonly type: "folder.update" }> | null {
  if (choice.by === "off") {
    return folder.autoFile ? { type: "folder.update", folderId: folder.id, autoFile: false } : null;
  }
  const current = threadFolderCollect(folder);
  const base = current.custom ? COLLECT_OFF : current;
  const toggle = (values: ReadonlyArray<string>, by: "branch" | "worktree") =>
    choice.by !== by
      ? values
      : values.includes(choice.value)
        ? values.filter((value) => value !== choice.value)
        : [...values, choice.value];
  const topic = choice.by === "topic" ? !base.topic : base.topic;
  const branches = toggle(base.branches, "branch");
  const worktrees = toggle(base.worktrees, "worktree");
  if (!topic && branches.length === 0 && worktrees.length === 0) {
    return { type: "folder.update", folderId: folder.id, rule: null, autoFile: false };
  }
  const rule: ThreadFolderRule = {
    ...(topic ? { smart: true } : {}),
    ...(branches.length > 0 ? { branches } : {}),
    ...(worktrees.length > 0 ? { worktrees } : {}),
  };
  return { type: "folder.update", folderId: folder.id, rule, autoFile: true };
}

/** A Collect submenu label: "By branch", "By branch: main", or "By branch: main +2". */
export function threadFolderCollectLabel(title: string, values: ReadonlyArray<string>): string {
  const [first] = values;
  if (first === undefined) return title;
  return values.length === 1 ? `${title}: ${first}` : `${title}: ${first} +${values.length - 1}`;
}

/**
 * Branches and worktree names to offer, from the folder's own threads first and then the
 * environment's most recent ones, with the folder's current values always included.
 */
export function threadFolderCollectChoices(
  folder: EnvironmentThreadFolder,
  threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
  }>,
  limit = 6,
): { readonly branches: ReadonlyArray<string>; readonly worktrees: ReadonlyArray<string> } {
  const members = new Set<string>(folder.threadIds);
  const current = threadFolderCollect(folder);
  // Ranks each value by its best thread: folder members first, then the most recent.
  const rank = (by: "branch" | "worktree") => {
    const best = new Map<string, readonly [member: number, updatedAt: string]>();
    for (const thread of threads) {
      if (thread.environmentId !== folder.environmentId || thread.archivedAt !== null) continue;
      const value =
        by === "branch"
          ? thread.branch
          : (thread.worktreePath
              ?.replace(/[\\/]+$/, "")
              .split(/[\\/]/)
              .at(-1) ?? null);
      if (!value) continue;
      const score = [Number(members.has(thread.id)), thread.updatedAt] as const;
      const previous = best.get(value);
      if (
        !previous ||
        score[0] > previous[0] ||
        (score[0] === previous[0] && score[1] > previous[1])
      )
        best.set(value, score);
    }
    const ordered = [...best]
      .sort(([, a], [, b]) => b[0] - a[0] || b[1].localeCompare(a[1]))
      .map(([value]) => value);
    const pinned = by === "branch" ? current.branches : current.worktrees;
    return [...new Set([...pinned, ...ordered])].slice(0, Math.max(limit, pinned.length));
  };
  return { branches: rank("branch"), worktrees: rank("worktree") };
}

export async function readThreadFolderMembers<
  T extends { readonly id: ThreadId; readonly environmentId: EnvironmentId },
>(
  folder: EnvironmentThreadFolder,
  loaded: ReadonlyArray<T>,
  readFamily: (threadId: ThreadId) => Promise<ReadonlyArray<T>>,
): Promise<ReadonlyArray<T>> {
  const ids = new Set(folder.threadIds);
  const members = new Map(
    loaded
      .filter((thread) => thread.environmentId === folder.environmentId && ids.has(thread.id))
      .map((thread) => [thread.id, thread]),
  );
  const visited = new Set(members.keys());
  for (const id of ids) {
    if (visited.has(id)) continue;
    visited.add(id);
    for (const thread of await readFamily(id)) {
      if (thread.environmentId !== folder.environmentId) continue;
      visited.add(thread.id);
      if (ids.has(thread.id)) members.set(thread.id, thread);
    }
  }
  return [...members.values()];
}

export function createThreadFolderMemberKeysAtom(
  foldersAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadFolder>>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<{
    readonly threads: ReadonlyArray<{ readonly id: ThreadId }>;
  } | null>,
) {
  return Atom.make((get) => {
    const missing = new Map<EnvironmentId, Set<ThreadId>>();
    const present = new Map<EnvironmentId, Set<ThreadId>>();
    for (const folder of get(foldersAtom)) {
      let ids = present.get(folder.environmentId);
      if (ids === undefined) {
        ids = new Set(get(snapshotAtom(folder.environmentId))?.threads.map((thread) => thread.id));
        present.set(folder.environmentId, ids);
      }
      for (const id of folder.threadIds) {
        if (ids.has(id)) continue;
        const members = missing.get(folder.environmentId) ?? new Set<ThreadId>();
        members.add(id);
        missing.set(folder.environmentId, members);
      }
    }
    return JSON.stringify(
      [...missing]
        .flatMap(([environmentId, ids]) =>
          [...ids].map((threadId) => ({ environmentId, threadId })),
        )
        .sort(
          (a, b) =>
            a.environmentId.localeCompare(b.environmentId) || a.threadId.localeCompare(b.threadId),
        ),
    );
  });
}
