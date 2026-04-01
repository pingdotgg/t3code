import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("../nativeApi", () => ({
  ensureNativeApi: vi.fn(),
}));

vi.mock("../wsRpcClient", () => ({
  getWsRpcClient: vi.fn(),
}));

import {
  gitBranchesQueryOptions,
  gitMutationKeys,
  gitQueryKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  invalidateGitStatusQuery,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "./gitReactQuery";

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction("/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction("/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull("/repo/a")).not.toEqual(gitMutationKeys.pull("/repo/b"));
  });

  it("scopes pull request thread preparation keys by cwd", () => {
    expect(gitMutationKeys.preparePullRequestThread("/repo/a")).not.toEqual(
      gitMutationKeys.preparePullRequestThread("/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for preparePullRequestThread", () => {
    const options = gitPreparePullRequestThreadMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.preparePullRequestThread("/repo/a"));
  });
});

describe("invalidateGitQueries", () => {
  it("can invalidate a single cwd without blasting other git query scopes", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(gitQueryKeys.status("/repo/a"), { ok: "a" });
    queryClient.setQueryData(gitQueryKeys.branches("/repo/a"), { ok: "a-branches" });
    queryClient.setQueryData(gitQueryKeys.status("/repo/b"), { ok: "b" });
    queryClient.setQueryData(gitQueryKeys.branches("/repo/b"), { ok: "b-branches" });

    await invalidateGitQueries(queryClient, { cwd: "/repo/a" });

    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(gitBranchesQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/b").queryKey)?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(gitBranchesQueryOptions("/repo/b").queryKey)?.isInvalidated,
    ).toBe(false);
  });
});

describe("invalidateGitStatusQuery", () => {
  it("invalidates only status for the selected cwd", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(gitQueryKeys.status("/repo/a"), { ok: "a" });
    queryClient.setQueryData(gitQueryKeys.branches("/repo/a"), { ok: "a-branches" });
    queryClient.setQueryData(gitQueryKeys.status("/repo/b"), { ok: "b" });

    await invalidateGitStatusQuery(queryClient, "/repo/a");

    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(gitBranchesQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/b").queryKey)?.isInvalidated,
    ).toBe(false);
  });
});
