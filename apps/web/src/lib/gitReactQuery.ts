import type { ProjectId } from "@t3tools/contracts";
import type { GitStackedAction } from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

const GIT_STATUS_STALE_TIME_MS = 5_000;
const GIT_STATUS_REFETCH_INTERVAL_MS = 15_000;
const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;

export const gitQueryKeys = {
  all: ["git"] as const,
  status: (projectId: ProjectId | null, cwd: string | null) => ["git", "status", projectId, cwd] as const,
  branches: (projectId: ProjectId | null, cwd: string | null) =>
    ["git", "branches", projectId, cwd] as const,
};

export const gitMutationKeys = {
  init: (projectId: ProjectId | null, cwd: string | null) =>
    ["git", "mutation", "init", projectId, cwd] as const,
  checkout: (projectId: ProjectId | null, cwd: string | null) =>
    ["git", "mutation", "checkout", projectId, cwd] as const,
  runStackedAction: (projectId: ProjectId | null, cwd: string | null) =>
    ["git", "mutation", "run-stacked-action", projectId, cwd] as const,
  pull: (projectId: ProjectId | null, cwd: string | null) =>
    ["git", "mutation", "pull", projectId, cwd] as const,
};

export function invalidateGitQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
}

export function gitStatusQueryOptions(
  projectIdOrCwd: ProjectId | string | null,
  maybeCwd?: string | null,
) {
  const projectId = maybeCwd === undefined ? null : (projectIdOrCwd as ProjectId | null);
  const cwd = maybeCwd === undefined ? (projectIdOrCwd as string | null) : maybeCwd;
  return queryOptions({
    queryKey: gitQueryKeys.status(projectId, cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git status is unavailable.");
      return api.git.status({ ...(projectId ? { projectId } : {}), cwd });
    },
    enabled: cwd !== null,
    staleTime: GIT_STATUS_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: GIT_STATUS_REFETCH_INTERVAL_MS,
  });
}

export function gitBranchesQueryOptions(
  projectIdOrCwd: ProjectId | string | null,
  maybeCwd?: string | null,
) {
  const projectId = maybeCwd === undefined ? null : (projectIdOrCwd as ProjectId | null);
  const cwd = maybeCwd === undefined ? (projectIdOrCwd as string | null) : maybeCwd;
  return queryOptions({
    queryKey: gitQueryKeys.branches(projectId, cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git branches are unavailable.");
      return api.git.listBranches({ ...(projectId ? { projectId } : {}), cwd });
    },
    enabled: cwd !== null,
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_BRANCHES_REFETCH_INTERVAL_MS,
  });
}

export function gitInitMutationOptions(input: {
  projectId: ProjectId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.projectId, input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git init is unavailable.");
      return api.git.init({ ...(input.projectId ? { projectId: input.projectId } : {}), cwd: input.cwd });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCheckoutMutationOptions(input: {
  projectId?: ProjectId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.checkout(input.projectId ?? null, input.cwd),
    mutationFn: async (branch: string) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git checkout is unavailable.");
      return api.git.checkout({
        ...(input.projectId ? { projectId: input.projectId } : {}),
        cwd: input.cwd,
        branch,
      });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  projectId?: ProjectId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runStackedAction(input.projectId ?? null, input.cwd),
    mutationFn: async ({
      action,
      commitMessage,
      featureBranch,
    }: {
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
    }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git action is unavailable.");
      return api.git.runStackedAction({
        ...(input.projectId ? { projectId: input.projectId } : {}),
        cwd: input.cwd,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
      });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPullMutationOptions(input: {
  projectId?: ProjectId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.pull(input.projectId ?? null, input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git pull is unavailable.");
      return api.git.pull({ ...(input.projectId ? { projectId: input.projectId } : {}), cwd: input.cwd });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCreateWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      projectId,
      cwd,
      branch,
      newBranch,
      path,
    }: {
      projectId?: ProjectId;
      cwd: string;
      branch: string;
      newBranch: string;
      path?: string | null;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree creation is unavailable.");
      return api.git.createWorktree({
        ...(projectId ? { projectId } : {}),
        cwd,
        branch,
        newBranch,
        path: path ?? null,
      });
    },
    mutationKey: ["git", "mutation", "create-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      projectId,
      cwd,
      path,
      force,
    }: {
      projectId?: ProjectId;
      cwd: string;
      path: string;
      force?: boolean;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree removal is unavailable.");
      return api.git.removeWorktree({ ...(projectId ? { projectId } : {}), cwd, path, force });
    },
    mutationKey: ["git", "mutation", "remove-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}
