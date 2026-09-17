import type { FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId, ProjectId, type ReviewDiffFileContentsResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createGitDiffFileContentsLoader,
  createPullRequestDiffFileContentsLoader,
} from "./diffFileContents";

const SOURCE = {
  environmentId: EnvironmentId.make("environment-1"),
  cwd: "/workspace",
  sourceKind: "branch-range" as const,
  baseRef: "main",
  headRef: "feature",
  cacheKey: "comparison-1",
};

function fileDiff(type: FileDiffMetadata["type"] = "rename-changed"): FileDiffMetadata {
  return {
    type,
    prevName: "a/src/old-name.ts",
    name: "b/src/new-name.ts",
  } as FileDiffMetadata;
}

describe("createGitDiffFileContentsLoader", () => {
  it("loads both sides with normalized paths and comparison-scoped cache keys", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).resolves.toEqual({
      oldFile: {
        name: "src/old-name.ts",
        contents: "before\n",
        cacheKey: "comparison-1:old:src/old-name.ts",
      },
      newFile: {
        name: "src/new-name.ts",
        contents: "after\n",
        cacheKey: "comparison-1:new:src/new-name.ts",
      },
    });
    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        cwd: "/workspace",
        sourceKind: "branch-range",
        changeType: "rename-changed",
        baseRef: "main",
        headRef: "feature",
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
      },
    });
  });

  it("loads a pure rename from its one shared file", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "same\n", newContents: "same\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff("rename-pure"))).resolves.toMatchObject({
      oldFile: null,
      newFile: { name: "src/new-name.ts", contents: "same\n" },
    });
  });

  it("passes command failures through to Pierre's expansion handling", async () => {
    const failure = new Error("revision is not available locally");
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.failure<ReviewDiffFileContentsResult, Error>(Cause.fail(failure)),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).rejects.toBe(failure);
  });
});

describe("createPullRequestDiffFileContentsLoader", () => {
  it("expands the exact displayed pull request revision", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }),
    );
    const reviewRevision = { version: 7, headOid: "head-7", baseOid: "base-2" };
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
      environmentId: SOURCE.environmentId,
      reference: {
        projectId: ProjectId.make("project-1"),
        repository: "acme/web",
        number: 3,
      },
      commit: null,
      reviewRevision,
      cacheKey: "pull-request-3-revision-7",
    });

    await load(fileDiff());

    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        projectId: "project-1",
        repository: "acme/web",
        number: 3,
        reviewRevision,
        changeType: "rename-changed",
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
      },
    });
  });

  it("preserves commit expansion without adding a pull request revision", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }),
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
      environmentId: SOURCE.environmentId,
      reference: {
        projectId: ProjectId.make("project-1"),
        repository: "acme/web",
        number: 3,
      },
      commit: "commit-1",
      cacheKey: "pull-request-3-commit-1",
    });

    await load(fileDiff());

    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        projectId: "project-1",
        repository: "acme/web",
        number: 3,
        commit: "commit-1",
        changeType: "rename-changed",
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
      },
    });
  });
});
