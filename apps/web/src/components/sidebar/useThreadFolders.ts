import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectThreadFolder,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { create } from "zustand";

import { m } from "../../i18n/messages";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  moveThreadsToFolder,
  removeThreadFolder,
  renameThreadFolder,
  resolveGroupThreadFolders,
  sameThreadFolders,
  threadFolderMemberKey,
  type ThreadFolderSummary,
} from "./threadFolders.logic";

const NO_FOLDERS: readonly ProjectThreadFolder[] = [];

type PendingWrite = {
  readonly next: readonly ProjectThreadFolder[];
  /** The server's copy when the write started; once it lands, a different copy wins. */
  readonly base: readonly ProjectThreadFolder[];
  readonly landed: boolean;
};

// Shared so a write after an awaited dialog builds on the writes before it.
const usePendingWrites = create<{ writes: ReadonlyMap<string, PendingWrite> }>(() => ({
  writes: new Map(),
}));

function effectiveFolders(
  stored: readonly ProjectThreadFolder[],
  write: PendingWrite | undefined,
): readonly ProjectThreadFolder[] {
  if (write === undefined || sameThreadFolders(stored, write.next)) return stored;
  return write.landed && !sameThreadFolders(stored, write.base) ? stored : write.next;
}

function storedFolders(
  config: Pick<EnvironmentServerConfig, "settings"> | null | undefined,
  member: ScopedProjectRef,
): readonly ProjectThreadFolder[] {
  return config?.settings.projectThreadFolders?.[member.projectId] ?? NO_FOLDERS;
}

function readConfig(environmentId: EnvironmentId) {
  return appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
}

function readFolders(member: ScopedProjectRef) {
  return effectiveFolders(
    storedFolders(readConfig(member.environmentId), member),
    usePendingWrites.getState().writes.get(threadFolderMemberKey(member)),
  );
}

function setPendingWrite(key: string, update: (write: PendingWrite) => PendingWrite | null) {
  usePendingWrites.setState(({ writes }) => {
    const current = writes.get(key);
    if (current === undefined) return { writes };
    const next = update(current);
    const updated = new Map(writes);
    if (next === null) updated.delete(key);
    else updated.set(key, next);
    return { writes: updated };
  });
}

export interface ThreadFolderMove {
  readonly environmentId: EnvironmentId;
  readonly projectId: ScopedProjectRef["projectId"];
  readonly id: ThreadId;
}

/** The group's primary project first, where new folders go, then its other members. */
function groupMembers(group: SidebarProjectSnapshot): ScopedProjectRef[] {
  const primary = { environmentId: group.environmentId, projectId: group.id };
  return [
    primary,
    ...group.memberProjectRefs.filter(
      (ref) => threadFolderMemberKey(ref) !== threadFolderMemberKey(primary),
    ),
  ];
}

const supportsFolders = (environmentId: EnvironmentId) =>
  readConfig(environmentId)?.environment.capabilities.projectThreadFolders === true;

/**
 * Folders inside boring-sidebar project folders. They live in each environment's
 * settings so every client of that environment sees them; writes show at once and
 * give way to the server's copy when it arrives.
 */
export function useThreadFolders(
  serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>,
) {
  const gt = useGT();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const writes = usePendingWrites((state) => state.writes);

  const canEdit = (environmentId: EnvironmentId) =>
    supportsFolders(environmentId) && readEnvironmentScope(environmentId, AuthSettingsWriteScope);

  const write = (
    member: ScopedProjectRef,
    change: (folders: readonly ProjectThreadFolder[]) => readonly ProjectThreadFolder[],
  ) => {
    if (!canEdit(member.environmentId)) return;
    const current = readFolders(member);
    const next = change(current);
    if (sameThreadFolders(next, current)) return;
    const key = threadFolderMemberKey(member);
    const entry: PendingWrite = {
      next,
      base: storedFolders(readConfig(member.environmentId), member),
      landed: false,
    };
    usePendingWrites.setState(({ writes }) => ({ writes: new Map(writes).set(key, entry) }));
    void (async () => {
      const result = await updateSettings({
        environmentId: member.environmentId,
        input: {
          patch: {
            projectThreadFolders: { [member.projectId]: next.length === 0 ? null : next },
          },
        },
      });
      setPendingWrite(key, (pending) =>
        pending !== entry ? pending : result._tag === "Success" ? { ...entry, landed: true } : null,
      );
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not update folders"),
            description:
              thrownErrorMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
          }),
        );
      }
    })();
  };

  const foldersOf = (member: ScopedProjectRef) =>
    effectiveFolders(
      storedFolders(serverConfigs.get(member.environmentId), member),
      writes.get(threadFolderMemberKey(member)),
    );

  return {
    resolve: (group: SidebarProjectSnapshot) =>
      serverConfigs.get(group.environmentId)?.environment.capabilities.projectThreadFolders === true
        ? resolveGroupThreadFolders(groupMembers(group), foldersOf)
        : { folders: [], folderIdByThreadKey: new Map<string, string>() },
    canEdit: (group: SidebarProjectSnapshot) => canEdit(group.environmentId),
    create: (group: SidebarProjectSnapshot, name: string): ThreadFolderSummary => {
      const folder = { id: randomUUID(), name };
      write(groupMembers(group)[0]!, (folders) => [...folders, { ...folder, threadIds: [] }]);
      return folder;
    },
    rename: (group: SidebarProjectSnapshot, folderId: string, name: string) => {
      for (const member of groupMembers(group)) {
        write(member, (folders) => renameThreadFolder(folders, folderId, name));
      }
    },
    remove: (group: SidebarProjectSnapshot, folderId: string) => {
      for (const member of groupMembers(group)) {
        write(member, (folders) => removeThreadFolder(folders, folderId));
      }
    },
    /** Moves threads into `target`, or out of their folders when it is null. */
    move: (
      group: SidebarProjectSnapshot,
      threads: readonly ThreadFolderMove[],
      target: ThreadFolderSummary | null,
    ) => {
      for (const member of groupMembers(group)) {
        const threadIds = threads.flatMap((thread) =>
          thread.environmentId === member.environmentId && thread.projectId === member.projectId
            ? [thread.id]
            : [],
        );
        if (threadIds.length > 0) {
          write(member, (folders) => moveThreadsToFolder(folders, threadIds, target));
        }
      }
    },
  };
}
