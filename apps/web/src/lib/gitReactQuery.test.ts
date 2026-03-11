import type { NativeApi } from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
} from "./gitReactQuery";
import * as nativeApi from "../nativeApi";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction("/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction("/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull("/repo/a")).not.toEqual(gitMutationKeys.pull("/repo/b"));
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction("/repo/a"));
  });

  it("forwards promote target branch to the native API", async () => {
    const runStackedAction = vi.fn().mockResolvedValue({});
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      git: {
        runStackedAction,
      },
    } as unknown as NativeApi);

    const options = gitRunStackedActionMutationOptions({ cwd: "/repo/a", queryClient });
    await options.mutationFn?.({ action: "promote", targetBranch: "main" }, {} as never);

    expect(runStackedAction).toHaveBeenCalledWith({
      cwd: "/repo/a",
      action: "promote",
      targetBranch: "main",
    });
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull("/repo/a"));
  });
});
