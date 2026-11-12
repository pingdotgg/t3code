import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  createThreadFolderMemberKeysAtom,
  type EnvironmentThreadFolder,
  findThreadFolder,
  scopedThreadFolderKey,
} from "@t3tools/client-runtime/state/thread-folders";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectIconOverride,
  type ScopedThreadRef,
  ThreadFolderId,
  type ThreadFolderListResult,
  type ThreadFolderMutation,
  type ThreadFolderMutationResult,
  type ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { readEnvironmentScope } from "./session";
import { environmentSnapshotAtom } from "./shell";
import { threadFamilies } from "./threads";

const EMPTY_FOLDERS: ReadonlyArray<EnvironmentThreadFolder> = Object.freeze([]);

/** Folders keep their identity across unrelated updates, so the sidebar re-partitions only when one changes. */
const environmentFoldersAtomFamily = Atom.family((environmentId: EnvironmentId) => {
  let previousList: ThreadFolderListResult | null = null;
  let previous = EMPTY_FOLDERS;
  return Atom.make((get) => {
    const result = get(serverEnvironment.threadFoldersLive({ environmentId, input: {} }));
    if (!AsyncResult.isSuccess(result) || result.value === previousList) return previous;
    previousList = result.value;
    previous = result.value.folders.map((folder) => ({ ...folder, environmentId }));
    return previous;
  }).pipe(Atom.withLabel(`web-thread-folders:${environmentId}`));
});

const threadFolderEnvironmentIdsAtom = (() => {
  let previous: ReadonlyArray<EnvironmentId> = [];
  return Atom.make((get) => {
    const next = [...get(environmentServerConfigsAtom)]
      .filter(([, config]) => config.environment.capabilities.threadFolders === true)
      .map(([environmentId]) => environmentId);
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel("web-thread-folder-environments"));
})();

const threadFoldersAtom = (() => {
  let previous = EMPTY_FOLDERS;
  return Atom.make((get) => {
    const next = get(threadFolderEnvironmentIdsAtom).flatMap((environmentId) =>
      get(environmentFoldersAtomFamily(environmentId)),
    );
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel("web-thread-folders"));
})();

const threadFolderMemberKeysAtom = createThreadFolderMemberKeysAtom(
  threadFoldersAtom,
  environmentSnapshotAtom,
);

/** Every folder on every environment that supports them, in folder order. */
export function useThreadFolders(): ReadonlyArray<EnvironmentThreadFolder> {
  const memberKeys = useAtomValue(threadFolderMemberKeysAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retains paged-out folder member shells in the family registry while the sidebar is mounted
  useEffect(() => {
    const releases = (JSON.parse(memberKeys) as ReadonlyArray<ScopedThreadRef>).map((ref) =>
      threadFamilies.mount(appAtomRegistry, ref.environmentId, ref.threadId),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [memberKeys]);
  return useAtomValue(threadFoldersAtom);
}

export function readThreadFolders(): ReadonlyArray<EnvironmentThreadFolder> {
  return appAtomRegistry.get(threadFoldersAtom);
}

export function readEnvironmentSupportsThreadFolders(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(threadFolderEnvironmentIdsAtom).includes(environmentId);
}

export function readThreadFoldersLoaded(environmentId: EnvironmentId): boolean {
  return AsyncResult.isSuccess(
    appAtomRegistry.get(serverEnvironment.threadFoldersLive({ environmentId, input: {} })),
  );
}

export function readThreadFolder(ref: ScopedThreadRef): EnvironmentThreadFolder | null {
  return findThreadFolder(readThreadFolders(), {
    environmentId: ref.environmentId,
    id: ref.threadId,
  });
}

const NEW_THREAD_FOLDER_NAME = "New folder";

/** Runs one folder change and toasts on failure; resolves to the new folder list, or null. */
export async function mutateThreadFolders(
  environmentId: EnvironmentId,
  mutation: ThreadFolderMutation,
  failureTitle = "Could not update folder",
): Promise<ThreadFolderMutationResult | null> {
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: "This connection cannot change folders.",
      }),
    );
    return null;
  }
  const result: AtomCommandResult<ThreadFolderMutationResult, unknown> = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.mutateThreadFolders,
    { environmentId, input: mutation },
    { label: "thread folders", reportFailure: false },
  );
  if (result._tag === "Success") return result.value;
  if (!isAtomCommandInterrupted(result)) {
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  }
  return null;
}

/** Creates a folder holding `threadIds` and resolves to its id once the server has it. */
export async function createThreadFolder(input: {
  readonly environmentId: EnvironmentId;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly name?: string;
  readonly icon?: ProjectIconOverride | null;
}): Promise<ThreadFolderId | null> {
  const folderId = ThreadFolderId.make(`folder:${randomUUID()}`);
  const result = await mutateThreadFolders(
    input.environmentId,
    {
      type: "folder.create",
      folderId,
      name: input.name ?? NEW_THREAD_FOLDER_NAME,
      ...(input.icon === undefined ? {} : { icon: input.icon }),
      ...(input.threadIds.length > 0 ? { threadIds: [...input.threadIds] } : {}),
    },
    "Could not create folder",
  );
  return result === null ? null : folderId;
}

export function moveThreadsToFolder(input: {
  readonly environmentId: EnvironmentId;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly folderId: ThreadFolderId | null;
}): Promise<ThreadFolderMutationResult | null> {
  return mutateThreadFolders(
    input.environmentId,
    { type: "folder.move", threadIds: [...input.threadIds], folderId: input.folderId },
    input.folderId === null ? "Could not remove from folder" : "Could not move to folder",
  );
}

/** Folder ids the inline rename should open on; a header renders its input while its key is here. */
const pendingRenameAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-thread-folder-pending-rename"),
);

export function requestThreadFolderRename(folderKey: string | null): void {
  appAtomRegistry.set(pendingRenameAtom, folderKey);
}

export function useThreadFolderRenameKey(): string | null {
  return useAtomValue(pendingRenameAtom);
}

/** Folders whose related threads are being added; the folder menu shows the work instead of a second run. */
const addingRelatedAtom = Atom.make<ReadonlyArray<string>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-thread-folder-adding-related"),
);

export function isAddingRelatedThreads(folder: EnvironmentThreadFolder): boolean {
  return appAtomRegistry.get(addingRelatedAtom).includes(scopedThreadFolderKey(folder));
}

export async function addRelatedThreads(folder: EnvironmentThreadFolder): Promise<void> {
  const key = scopedThreadFolderKey(folder);
  if (isAddingRelatedThreads(folder)) return;
  appAtomRegistry.set(addingRelatedAtom, [...appAtomRegistry.get(addingRelatedAtom), key]);
  try {
    await mutateThreadFolders(
      folder.environmentId,
      { type: "folder.applyRule", folderId: folder.id },
      "Could not add related threads",
    );
  } finally {
    appAtomRegistry.set(
      addingRelatedAtom,
      appAtomRegistry.get(addingRelatedAtom).filter((entry) => entry !== key),
    );
  }
}
