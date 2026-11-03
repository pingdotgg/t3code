import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { threadRepositoriesTarget } from "@t3tools/client-runtime/state/thread-repositories";
import type { WorkspaceListRepositoriesResult } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { workspaceRepositoryEnvironment } from "../state/workspaceRepositories";
import { useWorktreeRepositorySelectionStore } from "../worktreeRepositorySelectionStore";
import { resolveLaunchRepositories, trackedGitRepositories } from "./multiRepo";

/**
 * Waits for the repo list of a thread at `worktreePath`, or the home folder when null. Null for
 * single-repo projects, which make no request, and for servers that cannot list repos. Queries
 * wait for a connection, so callers check the environment is connected first.
 */
export async function readWorkspaceRepositories(
  project: EnvironmentProject,
  worktreePath: string | null,
): Promise<WorkspaceListRepositoriesResult | null> {
  const target = threadRepositoriesTarget({
    environmentId: project.environmentId,
    project,
    worktreePath,
  });
  if (target === null) return null;
  const result = await executeAtomQuery(
    appAtomRegistry,
    workspaceRepositoryEnvironment.repositories(target),
    { reportDefect: false, reportFailure: false },
  );
  return result._tag === "Success" ? result.value : null;
}

/** The Repos chip's choice for a new task folder; undefined starts every repo from its default. */
export async function readLaunchRepositories(project: EnvironmentProject, selectionKey: string) {
  const selection = useWorktreeRepositorySelectionStore.getState().byKey[selectionKey];
  if (selection === undefined) return undefined;
  const workspace = await readWorkspaceRepositories(project, null);
  return resolveLaunchRepositories(
    trackedGitRepositories(workspace).filter((repository) => !repository.missing),
    selection,
  );
}
