// @vitest-environment jsdom

import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { legacyProjectMergeMethod } from "~/components/pullRequest/legacyMergeMethod";
import { deriveLogicalProjectKeyFromSettings } from "~/logicalProject";
import type { Project } from "~/types";
import { PERSISTED_STATE_KEY, useUiStateStore } from "~/uiStateStore";

import { hostPullRequestPreferences } from "./hostPullRequestPreferences";

afterEach(() => {
  useUiStateStore.getState().setPullRequestMergeMethod("merge");
  vi.useRealTimers();
});

describe("the host's remembered merge method", () => {
  it("is the native panel's own persisted pick, shared both ways", () => {
    vi.useFakeTimers();
    const changes = vi.fn();
    const stop = hostPullRequestPreferences.subscribe(changes);

    hostPullRequestPreferences.setLastMergeMethod("squash");
    expect(useUiStateStore.getState().pullRequestMergeMethod).toBe("squash");
    expect(changes).toHaveBeenCalledTimes(1);
    // Written where native keeps it, so the pick survives a reload.
    vi.advanceTimersByTime(1_000);
    expect(JSON.parse(localStorage.getItem(PERSISTED_STATE_KEY)!).pullRequestMergeMethod).toBe(
      "squash",
    );

    // A pick in the native panel reaches the plugin.
    useUiStateStore.getState().setPullRequestMergeMethod("rebase");
    expect(hostPullRequestPreferences.lastMergeMethod()).toBe("rebase");
    expect(changes).toHaveBeenCalledTimes(2);
    stop();
  });

  it("ignores a method the native store cannot hold", () => {
    hostPullRequestPreferences.setLastMergeMethod("fast-forward" as never);
    expect(hostPullRequestPreferences.lastMergeMethod()).toBe("merge");
  });
});

describe("the legacy per-project merge method", () => {
  const repositoryIdentity = {
    canonicalKey: "github.com/example/shared-repo",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/example/shared-repo.git",
    },
  };
  const grouping = {
    sidebarProjectGroupingMode: "repository" as const,
    sidebarProjectGroupingOverrides: {},
  };
  const project = (id: string, environmentId: string): Project => ({
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make(environmentId),
    title: "shared-repo",
    workspaceRoot: `/tmp/${id}`,
    repositoryIdentity,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  });

  it("reads the override under the project's sidebar group key", () => {
    const projects = [project("local", "env-a"), project("remote", "env-b")];
    const key = deriveLogicalProjectKeyFromSettings(projects[0]!, grouping);
    const lookup = (environmentId: string, projectId: string) =>
      legacyProjectMergeMethod({
        projects,
        grouping,
        overrides: { [key]: "rebase" },
        primaryEnvironmentId: EnvironmentId.make("env-a"),
        environmentId: EnvironmentId.make(environmentId),
        projectId,
      });
    expect(lookup("env-b", "remote")).toBe("rebase");
    expect(lookup("env-b", "missing")).toBeUndefined();
  });
});
