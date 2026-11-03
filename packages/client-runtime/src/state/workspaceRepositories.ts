import {
  type EnvironmentId,
  type OrchestrationProjectShell,
  type ScopedProjectRef,
  type WorkspaceListRepositoriesInput,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { parseProjectKey, projectKey } from "./entities.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Repos a thread works in, folder scans for Add project, and the guided home Git setup. */
export function createWorkspaceRepositoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    /** Lets a thread's repo list refresh when its project's tracked folders change. */
    readonly projectAtom?: (
      ref: ScopedProjectRef,
    ) => Atom.Atom<Pick<OrchestrationProjectShell, "trackedFolders"> | null>;
  } = {},
) {
  const { projectAtom } = options;
  // A string, so project updates that keep the same folders do not refresh the list.
  const trackedFoldersSignal =
    projectAtom === undefined
      ? undefined
      : Atom.family((key: string) => {
          const ref = parseProjectKey(key);
          return Atom.make((get) =>
            (get(projectAtom(ref))?.trackedFolders ?? [])
              .map((folder) => `${folder.path}\u0000${folder.name}`)
              .join("\u0001"),
          ).pipe(Atom.withLabel(`environment-data:workspace:tracked-folders:${key}`));
        });
  return {
    // The thread's worktree path is the query's cwd, so moving the thread starts a new query.
    repositories: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workspace:repositories",
      tag: WS_METHODS.workspaceListRepositories,
      staleTimeMs: 10_000,
      ...(trackedFoldersSignal === undefined
        ? {}
        : {
            refreshTrigger: (target: {
              readonly environmentId: EnvironmentId;
              readonly input: WorkspaceListRepositoriesInput;
            }) =>
              trackedFoldersSignal(
                projectKey({
                  environmentId: target.environmentId,
                  projectId: target.input.projectId,
                }),
              ),
          }),
    }),
    scanFolders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace:scan-folders",
      tag: WS_METHODS.workspaceScanFolders,
    }),
    previewHomeGitInit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace:preview-home-git-init",
      tag: WS_METHODS.workspacePreviewHomeGitInit,
    }),
    initializeHomeGit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace:initialize-home-git",
      tag: WS_METHODS.workspaceInitializeHomeGit,
    }),
  };
}
