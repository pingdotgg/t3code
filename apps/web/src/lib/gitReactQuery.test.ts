import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("../nativeApi", () => ({
  ensureNativeApi: vi.fn(),
}));

vi.mock("../wsRpcClient", () => ({
  getWsRpcClient: vi.fn(),
}));

import type { InfiniteData } from "@tanstack/react-query";
import type { GitListBranchesResult } from "@t3tools/contracts";

import {
  gitBranchSearchInfiniteQueryOptions,
  gitMutationKeys,
  gitQueryKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  invalidateGitStatusQuery,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "./gitReactQuery";

const BRANCH_QUERY_RESULT: GitListBranchesResult = {
  branches: [],
  isRepo: true,
  hasOriginRemote: true,
  nextCursor: null,
  totalCount: 0,
};

const BRANCH_SEARCH_RESULT: InfiniteData<GitListBranchesResult, number> = {
  pages: [BRANCH_QUERY_RESULT],
  pageParams: [0],
};

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
    queryClient.setQueryData(
      gitBranchSearchInfiniteQueryOptions({
        cwd: "/repo/a",
        query: "feature",
      }).queryKey,
      BRANCH_SEARCH_RESULT,
    );
    queryClient.setQueryData(gitQueryKeys.status("/repo/b"), { ok: "b" });
    queryClient.setQueryData(
      gitBranchSearchInfiniteQueryOptions({
        cwd: "/repo/b",
        query: "feature",
      }).queryKey,
      BRANCH_SEARCH_RESULT,
    );

    await invalidateGitQueries(queryClient, { cwd: "/repo/a" });

    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(
        gitBranchSearchInfiniteQueryOptions({
          cwd: "/repo/a",
          query: "feature",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/b").queryKey)?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(
        gitBranchSearchInfiniteQueryOptions({
          cwd: "/repo/b",
          query: "feature",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(false);
  });
});

describe("invalidateGitStatusQuery", () => {
  it("invalidates only status for the selected cwd", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(gitQueryKeys.status("/repo/a"), { ok: "a" });
    queryClient.setQueryData(gitQueryKeys.status("/repo/b"), { ok: "b" });

    await invalidateGitStatusQuery(queryClient, "/repo/a");

    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/b").queryKey)?.isInvalidated,
    ).toBe(false);
  });
});
