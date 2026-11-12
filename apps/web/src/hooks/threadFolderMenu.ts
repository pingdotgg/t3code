import {
  type EnvironmentThreadFolder,
  scopedThreadFolderKey,
} from "@t3tools/client-runtime/state/thread-folders";
import {
  type ContextMenuItem,
  type EnvironmentId,
  MAX_THREAD_FOLDER_MOVE_THREADS,
  ThreadFolderId,
  type ThreadId,
} from "@t3tools/contracts";

import {
  createThreadFolder,
  moveThreadsToFolder,
  readEnvironmentSupportsThreadFolders,
  readThreadFolders,
  requestThreadFolderRename,
} from "../state/threadFolders";

export type ThreadFolderMenuId =
  | "folder"
  | "folder:new"
  | "folder:new-from-selection"
  | "folder:remove"
  | `folder:id:${string}`;

const FOLDER_ID_PREFIX = "folder:id:";

export function isThreadFolderMenuId(id: string): id is ThreadFolderMenuId {
  return (
    id === "folder" ||
    id === "folder:new" ||
    id === "folder:new-from-selection" ||
    id === "folder:remove" ||
    id.startsWith(FOLDER_ID_PREFIX)
  );
}

interface FolderMenuInput {
  readonly environmentId: EnvironmentId;
  readonly threadIds: readonly ThreadId[];
  readonly canOperate: boolean;
}

export function moveToFolderMenuItem(
  input: FolderMenuInput & { readonly folders: ReadonlyArray<EnvironmentThreadFolder> },
): ContextMenuItem<ThreadFolderMenuId> {
  const folders = input.folders.filter((folder) => folder.environmentId === input.environmentId);
  const targets = new Set<string>(input.threadIds);
  const isFiled = folders.some((folder) => folder.threadIds.some((id) => targets.has(id)));
  const disabled = !input.canOperate;
  return {
    id: "folder",
    label: "Move to folder",
    icon: "folder",
    disabled,
    children: [
      { id: "folder:new", label: "New folder…", disabled },
      ...folders.map((folder, index) => ({
        id: `${FOLDER_ID_PREFIX}${folder.id}` as const,
        label: folder.name,
        checked:
          input.threadIds.length > 0 &&
          input.threadIds.every((id) => folder.threadIds.includes(id)),
        separatorBefore: index === 0,
        disabled,
      })),
      ...(isFiled
        ? [
            {
              id: "folder:remove" as const,
              label: "Remove from folder",
              separatorBefore: true,
              disabled,
            },
          ]
        : []),
    ],
  };
}

export function buildMoveToFolderMenuItem(
  input: FolderMenuInput,
): ContextMenuItem<ThreadFolderMenuId> | null {
  if (!readEnvironmentSupportsThreadFolders(input.environmentId)) return null;
  return moveToFolderMenuItem({ ...input, folders: readThreadFolders() });
}

export function buildMultiSelectFolderMenuItems(
  input: FolderMenuInput,
): ReadonlyArray<ContextMenuItem<ThreadFolderMenuId>> {
  const move = buildMoveToFolderMenuItem(input);
  if (move === null) return [];
  return [
    {
      id: "folder:new-from-selection",
      label: `New folder from selection (${input.threadIds.length})`,
      icon: "folder",
      disabled: !input.canOperate,
    },
    move,
  ];
}

async function createFolderAndRename(environmentId: EnvironmentId, threadIds: readonly ThreadId[]) {
  const id = await createThreadFolder({
    environmentId,
    threadIds: threadIds.slice(0, MAX_THREAD_FOLDER_MOVE_THREADS),
  });
  if (id === null) return;
  await moveThreadBatches({
    environmentId,
    threadIds: threadIds.slice(MAX_THREAD_FOLDER_MOVE_THREADS),
    folderId: id,
  });
  requestThreadFolderRename(scopedThreadFolderKey({ environmentId, id }));
}

async function moveThreadBatches(input: {
  readonly environmentId: EnvironmentId;
  readonly threadIds: readonly ThreadId[];
  readonly folderId: ThreadFolderId | null;
}) {
  for (let index = 0; index < input.threadIds.length; index += MAX_THREAD_FOLDER_MOVE_THREADS) {
    const result = await moveThreadsToFolder({
      ...input,
      threadIds: input.threadIds.slice(index, index + MAX_THREAD_FOLDER_MOVE_THREADS),
    });
    if (result === null) return;
  }
}

export function runThreadFolderMenuAction(
  id: string,
  input: { readonly environmentId: EnvironmentId; readonly threadIds: readonly ThreadId[] },
): boolean {
  const { environmentId, threadIds } = input;
  if (id === "folder:new" || id === "folder:new-from-selection") {
    void createFolderAndRename(environmentId, threadIds);
    return true;
  }
  if (id === "folder:remove") {
    void moveThreadBatches({ environmentId, threadIds, folderId: null });
    return true;
  }
  if (id.startsWith(FOLDER_ID_PREFIX)) {
    const folderId = ThreadFolderId.make(id.slice(FOLDER_ID_PREFIX.length));
    const folder = readThreadFolders().find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === folderId,
    );
    if (!folder || threadIds.every((threadId) => folder.threadIds.includes(threadId))) return true;
    void moveThreadBatches({ environmentId, threadIds, folderId });
    return true;
  }
  return id === "folder";
}
