import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  gitSuggestCommitAndBranchMutationOptions,
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

  it("scopes suggest-commit-and-branch keys by cwd", () => {
    expect(gitMutationKeys.suggestCommitAndBranch("/repo/a")).not.toEqual(
      gitMutationKeys.suggestCommitAndBranch("/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for suggestCommitAndBranch", () => {
    const options = gitSuggestCommitAndBranchMutationOptions({ cwd: "/repo/a" });
    expect(options.mutationKey).toEqual(gitMutationKeys.suggestCommitAndBranch("/repo/a"));
  });
});
