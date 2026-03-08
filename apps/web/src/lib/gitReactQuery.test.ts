import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
} from "./gitReactQuery";

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction(null, "/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction(null, "/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull(null, "/repo/a")).not.toEqual(
      gitMutationKeys.pull(null, "/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction(null, "/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull(null, "/repo/a"));
  });
});
