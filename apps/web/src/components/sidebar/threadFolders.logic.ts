import type { ProjectThreadFolder, ScopedProjectRef, ThreadId } from "@t3tools/contracts";

export type ThreadFolderSummary = Pick<ProjectThreadFolder, "id" | "name">;

export function threadFolderMemberKey(member: ScopedProjectRef): string {
  return `${member.environmentId}:${member.projectId}`;
}

/** Folder open state shares the project folder store under its own key. */
export function threadFolderExpansionKey(folderId: string): string {
  return `thread-folder:${folderId}`;
}

/**
 * A grouped project folder's subfolders. Each member project stores its own threads'
 * places, so one folder can live in several members under the same id; the first
 * member's name and order win.
 */
export function resolveGroupThreadFolders(
  members: readonly ScopedProjectRef[],
  foldersOf: (member: ScopedProjectRef) => readonly ProjectThreadFolder[],
): {
  folders: ThreadFolderSummary[];
  folderIdByThreadKey: Map<string, string>;
} {
  const folders: ThreadFolderSummary[] = [];
  const seen = new Set<string>();
  const folderIdByThreadKey = new Map<string, string>();
  for (const member of members) {
    for (const folder of foldersOf(member)) {
      if (!seen.has(folder.id)) {
        seen.add(folder.id);
        folders.push({ id: folder.id, name: folder.name });
      }
      for (const threadId of folder.threadIds) {
        const key = `${member.environmentId}:${threadId}`;
        if (!folderIdByThreadKey.has(key)) folderIdByThreadKey.set(key, folder.id);
      }
    }
  }
  return { folders, folderIdByThreadKey };
}

/** Splits a project folder's ordered threads into its subfolders and the rest, keeping order. */
export function splitThreadsIntoFolders<
  TThread extends { readonly environmentId: string; readonly id: string },
>(
  threads: readonly TThread[],
  folders: readonly ThreadFolderSummary[],
  folderIdByThreadKey: ReadonlyMap<string, string>,
): {
  subfolders: Array<{ folder: ThreadFolderSummary; threads: TThread[] }>;
  looseThreads: TThread[];
} {
  const subfolders = folders.map((folder) => ({ folder, threads: [] as TThread[] }));
  const byId = new Map(subfolders.map((subfolder) => [subfolder.folder.id, subfolder] as const));
  const looseThreads: TThread[] = [];
  for (const thread of threads) {
    const folderId = folderIdByThreadKey.get(`${thread.environmentId}:${thread.id}`);
    const subfolder = folderId === undefined ? undefined : byId.get(folderId);
    if (subfolder === undefined) looseThreads.push(thread);
    else subfolder.threads.push(thread);
  }
  return { subfolders, looseThreads };
}

/** Takes the threads out of every folder, then adds them to `target`, creating it if missing. */
export function moveThreadsToFolder(
  folders: readonly ProjectThreadFolder[],
  threadIds: readonly ThreadId[],
  target: ThreadFolderSummary | null,
): ProjectThreadFolder[] {
  const moving = new Set<string>(threadIds);
  const next = folders.map((folder) => ({
    ...folder,
    threadIds: folder.threadIds.filter((threadId) => !moving.has(threadId)),
  }));
  if (target === null) return next;
  const existing = next.find((folder) => folder.id === target.id);
  if (existing === undefined) {
    return [...next, { id: target.id, name: target.name, threadIds: [...threadIds] }];
  }
  existing.threadIds = [...existing.threadIds, ...threadIds];
  return next;
}

export function renameThreadFolder(
  folders: readonly ProjectThreadFolder[],
  folderId: string,
  name: string,
): ProjectThreadFolder[] {
  return folders.map((folder) => (folder.id === folderId ? { ...folder, name } : folder));
}

/** Deleting a folder puts its threads back in the project folder. */
export function removeThreadFolder(
  folders: readonly ProjectThreadFolder[],
  folderId: string,
): ProjectThreadFolder[] {
  return folders.filter((folder) => folder.id !== folderId);
}

export function sameThreadFolders(
  left: readonly ProjectThreadFolder[],
  right: readonly ProjectThreadFolder[],
): boolean {
  return (
    left.length === right.length &&
    left.every((folder, index) => {
      const other = right[index]!;
      return (
        folder.id === other.id &&
        folder.name === other.name &&
        folder.threadIds.length === other.threadIds.length &&
        folder.threadIds.every((threadId, threadIndex) => threadId === other.threadIds[threadIndex])
      );
    })
  );
}
