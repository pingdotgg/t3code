import type { ProjectDetails } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  commitProviderSettingsThenDefaultModel,
  confirmedProjectSettingsDraftKeys,
  type ProjectSettingsDraft,
  type ProjectSettingsDraftKey,
} from "./projectSettingsCommit";

const projectDetails = (overrides: Partial<ProjectDetails> = {}) =>
  ({
    id: "project-1",
    title: "Project",
    workspaceRoot: "/repo/project",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    settings: {
      remoteOverride: null,
      automaticGitFetchInterval: null,
      actionEnvironment: {},
      disabledProviderInstanceIds: [],
    },
    detected: {
      gitRoot: null,
      branch: null,
      remotes: [],
      primaryRemote: null,
    },
    effective: {
      title: "Project",
      remote: null,
    },
    ...overrides,
  }) as ProjectDetails;

describe("project settings commit state", () => {
  it("keeps optimistic values until refreshed details contain the committed values", () => {
    const draft = {
      projectKey: "environment-1:project-1",
      title: "Renamed project",
      automaticGitFetchInterval: 60_000,
    } satisfies ProjectSettingsDraft;
    const pendingKeys = ["title", "automaticGitFetchInterval"] satisfies ProjectSettingsDraftKey[];

    expect(confirmedProjectSettingsDraftKeys(draft, projectDetails(), pendingKeys)).toEqual([]);
    expect(
      confirmedProjectSettingsDraftKeys(
        draft,
        projectDetails({
          title: "Renamed project",
          settings: {
            remoteOverride: null,
            automaticGitFetchInterval: 60_000,
            actionEnvironment: {},
            disabledProviderInstanceIds: [],
          },
        }),
        pendingKeys,
      ),
    ).toEqual(pendingKeys);
  });

  it("only clears the remote draft fields represented in the optimistic draft", () => {
    const draft = {
      projectKey: "environment-1:project-1",
      overrideEnabled: false,
    } satisfies ProjectSettingsDraft;
    const pendingKeys = [
      "overrideEnabled",
      "provider",
      "remoteName",
      "remoteUrl",
      "webUrl",
    ] satisfies ProjectSettingsDraftKey[];

    expect(confirmedProjectSettingsDraftKeys(draft, projectDetails(), pendingKeys)).toEqual(
      pendingKeys,
    );
  });

  it("does not clear the default model when disabling its provider fails", async () => {
    const commitDefaultModel = vi.fn(async () => true);

    await expect(
      commitProviderSettingsThenDefaultModel(async () => false, commitDefaultModel),
    ).resolves.toBe(false);
    expect(commitDefaultModel).not.toHaveBeenCalled();
  });

  it("clears the default model after its provider is disabled successfully", async () => {
    const calls: string[] = [];

    await expect(
      commitProviderSettingsThenDefaultModel(
        async () => {
          calls.push("provider");
          return true;
        },
        async () => {
          calls.push("default-model");
          return true;
        },
      ),
    ).resolves.toBe(true);
    expect(calls).toEqual(["provider", "default-model"]);
  });
});
