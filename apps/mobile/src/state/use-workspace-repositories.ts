import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";
import { appAtomRegistry } from "./atom-registry";
import { projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";
import {
  resolveWorkspaceRepositoryFilter,
  updateWorkspaceRepositorySelection,
  type WorkspaceRepositorySelection,
  resolveWorkspaceGitCwd,
} from "./workspace-repository-selection";

const EMPTY_REPOSITORIES = Object.freeze([]);
const selections = Atom.family((_key: string) =>
  Atom.make<WorkspaceRepositorySelection>({ path: null, diffPath: null }).pipe(Atom.keepAlive),
);

export function useWorkspaceRepositories() {
  const { selectedThread, selectedEnvironmentRuntime } = useThreadSelection();
  const { selectedThreadCwd: workspaceCwd, selectedThreadWorktreePath } =
    useSelectedThreadWorktree();
  const supported =
    selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.workspaceRepositories ===
    true;
  const query = useEnvironmentQuery(
    supported && selectedThread && workspaceCwd
      ? projectEnvironment.listRepositories({
          environmentId: selectedThread.environmentId,
          input: { cwd: workspaceCwd },
        })
      : null,
  );
  const selectionAtom = selections(
    JSON.stringify([selectedThread?.environmentId, selectedThread?.id, workspaceCwd]),
  );
  const selection = useAtomValue(selectionAtom);
  const selectedPath = selection.path;
  const selectRepository = useCallback(
    (path: string | null) =>
      appAtomRegistry.set(
        selectionAtom,
        updateWorkspaceRepositorySelection(appAtomRegistry.get(selectionAtom), path),
      ),
    [selectionAtom],
  );
  const repositories = query.data?.repositories ?? EMPTY_REPOSITORIES;
  const selectedThreadCwd = resolveWorkspaceGitCwd(
    workspaceCwd,
    supported ? selectedPath : null,
    repositories,
  );
  return {
    repositories,
    repositoryFilter: resolveWorkspaceRepositoryFilter(selection.diffPath, repositories),
    selectedPath: selectedPath ?? ".",
    selectRepository,
    selectedThreadCwd: query.error ? null : selectedThreadCwd,
    selectedThreadWorktreePath,
    workspaceCwd,
    isChildRepository: supported && selectedPath !== null && selectedPath !== ".",
    refreshRepositories: query.refresh,
    repositoryError: query.error,
  };
}
