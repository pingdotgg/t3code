import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_FILESYSTEM_BROWSE_ATOM,
  EMPTY_FILESYSTEM_BROWSE_STATE,
  type FilesystemBrowseClient,
  type FilesystemBrowseState,
  type FilesystemBrowseTarget,
  createFilesystemBrowseManager,
  filesystemBrowseStateAtom,
  getFilesystemBrowseTargetKey,
} from "@t3tools/client-runtime";
import type {
  EnvironmentId,
  FilesystemBrowseInput,
  FilesystemBrowseResult,
} from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import {
  getEnvironmentClient,
  subscribeEnvironmentConnections,
} from "./environment-session-registry";

const filesystemBrowseManager = createFilesystemBrowseManager<EnvironmentId>({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => getEnvironmentClient(environmentId)?.filesystem ?? null,
  subscribeClientChanges: subscribeEnvironmentConnections,
});

function filesystemBrowseTargetForEnvironment(
  environmentId: EnvironmentId | null,
  input: FilesystemBrowseInput | null,
): FilesystemBrowseTarget<EnvironmentId> {
  return { key: environmentId, input };
}

export function refreshFilesystemBrowseForEnvironment(
  environmentId: EnvironmentId | null,
  input: FilesystemBrowseInput | null,
  client?: FilesystemBrowseClient | null,
): Promise<FilesystemBrowseResult | null> {
  return filesystemBrowseManager.refresh(
    filesystemBrowseTargetForEnvironment(environmentId, input),
    client ?? undefined,
  );
}

export function invalidateFilesystemBrowseForEnvironment(
  environmentId: EnvironmentId | null,
  input: FilesystemBrowseInput | null,
): void {
  filesystemBrowseManager.invalidate(filesystemBrowseTargetForEnvironment(environmentId, input));
}

export function resetFilesystemBrowseState(): void {
  filesystemBrowseManager.reset();
}

export function resetFilesystemBrowseStateForTests(): void {
  resetFilesystemBrowseState();
}

export function useFilesystemBrowse(
  environmentId: EnvironmentId | null,
  input: FilesystemBrowseInput | null,
): FilesystemBrowseState {
  const target = useMemo(
    () => filesystemBrowseTargetForEnvironment(environmentId, input),
    [environmentId, input],
  );

  useEffect(() => {
    return filesystemBrowseManager.watch(target);
  }, [target]);

  const targetKey = getFilesystemBrowseTargetKey(target);
  const state = useAtomValue(
    targetKey !== null ? filesystemBrowseStateAtom(targetKey) : EMPTY_FILESYSTEM_BROWSE_ATOM,
  );
  return targetKey === null ? EMPTY_FILESYSTEM_BROWSE_STATE : state;
}
