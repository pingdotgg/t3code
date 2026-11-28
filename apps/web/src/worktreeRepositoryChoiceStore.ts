import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface WorktreeRepositoryChoiceStore {
  /** Per project, the repositories last chosen for a new worktree thread. */
  readonly chosenByProject: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Per project, the branch its repositories start from where they have it. */
  readonly baseBranchByProject: Readonly<Record<string, string>>;
  readonly setBaseBranch: (
    project: { readonly environmentId: EnvironmentId; readonly id: ProjectId },
    baseBranch: string,
  ) => void;
  readonly remember: (
    project: { readonly environmentId: EnvironmentId; readonly id: ProjectId },
    repositoryPaths: ReadonlyArray<string>,
  ) => void;
}

const projectKey = (project: { readonly environmentId: EnvironmentId; readonly id: ProjectId }) =>
  `${project.environmentId}\u0000${project.id}`;

const useWorktreeRepositoryChoiceStore = create<WorktreeRepositoryChoiceStore>()(
  persist(
    (set) => ({
      chosenByProject: {},
      baseBranchByProject: {},
      setBaseBranch: (project, baseBranch) =>
        set((state) => ({
          baseBranchByProject: { ...state.baseBranchByProject, [projectKey(project)]: baseBranch },
        })),
      remember: (project, repositoryPaths) =>
        set((state) => ({
          chosenByProject: { ...state.chosenByProject, [projectKey(project)]: repositoryPaths },
        })),
    }),
    {
      name: "t3code:worktree-repository-choices:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

/** The project's last choice, which a new draft starts from; undefined before the first one. */
export function useRememberedWorktreeRepositories(
  project: { readonly environmentId: EnvironmentId; readonly id: ProjectId } | null,
): ReadonlyArray<string> | undefined {
  return useWorktreeRepositoryChoiceStore((state) =>
    project === null ? undefined : state.chosenByProject[projectKey(project)],
  );
}

/** Empty until the user names one: each repository then starts from its own default branch. */
export function useWorktreeBaseBranch(
  project: { readonly environmentId: EnvironmentId; readonly id: ProjectId } | null,
): string {
  return useWorktreeRepositoryChoiceStore((state) =>
    project === null ? "" : (state.baseBranchByProject[projectKey(project)] ?? ""),
  );
}

export function readWorktreeBaseBranch(project: {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}): string {
  return useWorktreeRepositoryChoiceStore.getState().baseBranchByProject[projectKey(project)] ?? "";
}

export function setWorktreeBaseBranch(
  project: { readonly environmentId: EnvironmentId; readonly id: ProjectId },
  baseBranch: string,
): void {
  useWorktreeRepositoryChoiceStore.getState().setBaseBranch(project, baseBranch);
}

export function rememberWorktreeRepositories(
  project: { readonly environmentId: EnvironmentId; readonly id: ProjectId },
  repositoryPaths: ReadonlyArray<string>,
): void {
  useWorktreeRepositoryChoiceStore.getState().remember(project, repositoryPaths);
}
