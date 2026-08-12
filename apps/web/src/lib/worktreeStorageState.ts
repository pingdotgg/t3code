import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type WorktreeStoragePreviewResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { vcsEnvironment } from "../state/vcs";

const ENVIRONMENT_KEY_SEPARATOR = "\u001f";

export interface WorktreeStoragePreviewEntry {
  readonly environmentId: EnvironmentId;
  readonly preview: WorktreeStoragePreviewResult;
}

interface WorktreeStoragePreviewsState {
  readonly previews: ReadonlyArray<WorktreeStoragePreviewEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
}

function makeEnvironmentKey(environmentIds: ReadonlyArray<EnvironmentId>): string {
  return [...environmentIds].sort().join(ENVIRONMENT_KEY_SEPARATOR);
}

function parseEnvironmentKey(key: string): ReadonlyArray<EnvironmentId> {
  return key.length === 0
    ? []
    : key
        .split(ENVIRONMENT_KEY_SEPARATOR)
        .map((environmentId) => EnvironmentId.make(environmentId));
}

function previewAtom(environmentId: EnvironmentId) {
  return vcsEnvironment.worktreeStoragePreview({ environmentId, input: {} });
}

const previewsAtom = Atom.family((environmentKey: string) =>
  Atom.make((get): WorktreeStoragePreviewsState => {
    const previews: WorktreeStoragePreviewEntry[] = [];
    let error: string | null = null;
    let isLoading = false;

    for (const environmentId of parseEnvironmentKey(environmentKey)) {
      const result = get(previewAtom(environmentId));
      isLoading ||= result.waiting;
      const preview = Option.getOrNull(AsyncResult.value(result));
      if (preview !== null) {
        previews.push({ environmentId, preview });
      }
      if (error === null && result._tag === "Failure") {
        error = "Could not inspect worktree storage in every connected environment.";
      }
    }

    return { previews, error, isLoading };
  }).pipe(Atom.withLabel(`web:worktree-storage-previews:${environmentKey}`)),
);

export function refreshWorktreeStorageForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(previewAtom(environmentId));
}

export function useWorktreeStoragePreviews(
  environmentIds: ReadonlyArray<EnvironmentId>,
): WorktreeStoragePreviewsState & { readonly refresh: () => void } {
  const environmentKey = useMemo(() => makeEnvironmentKey(environmentIds), [environmentIds]);
  const state = useAtomValue(previewsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      refreshWorktreeStorageForEnvironment(environmentId);
    }
  }, [environmentIds]);

  return { ...state, refresh };
}
