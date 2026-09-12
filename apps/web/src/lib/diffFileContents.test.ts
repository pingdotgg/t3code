import type { FileDiffMetadata } from "@pierre/diffs";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestDiffFileContentsResult,
  type ReviewDiffFileContentsResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createGitDiffFileContentsLoader,
  createPullRequestDiffFileContentsLoader,
  PULL_REQUEST_FILE_CONTENTS_CACHE_MAX_BYTES,
  PULL_REQUEST_FILE_CONTENTS_CACHE_MAX_ENTRIES,
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

const PR_SOURCE = {
  environmentId: EnvironmentId.make("environment-1"),
  reference: {
    projectId: ProjectId.make("project-1"),
    repository: "acme/web",
    number: 7,
  },
  commit: null,
  cacheKey: "pull-request:project-1/acme/web#7:commits:2:abc",
};

function prFileDiff(name = "b/src/file.ts", type: FileDiffMetadata["type"] = "change") {
  return { type, name } as FileDiffMetadata;
}

describe("createPullRequestDiffFileContentsLoader", () => {
  it("expands the same file twice for one request", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: "before\n",
        newContents: "after\n",
      }),
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    const first = await load(prFileDiff());
    const second = await load(prFileDiff());

    expect(second).toEqual(first);
    expect(getDiffFileContents).toHaveBeenCalledTimes(1);
    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        projectId: "project-1",
        repository: "acme/web",
        number: 7,
        changeType: "change",
        oldPath: "src/file.ts",
        newPath: "src/file.ts",
      },
    });
  });

  it("shares one request between concurrent expansions of the same file", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getDiffFileContents = vi.fn(async () => {
      await gate;
      return AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: "before\n",
        newContents: "after\n",
      });
    });
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    const both = Promise.all([load(prFileDiff()), load(prFileDiff())]);
    release();
    const [first, second] = await both;

    expect(second).toEqual(first);
    expect(getDiffFileContents).toHaveBeenCalledTimes(1);
  });

  it("reads each file once and keeps change types apart", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: "before\n",
        newContents: "after\n",
      }),
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    await load(prFileDiff("b/src/a.ts"));
    await load(prFileDiff("b/src/b.ts"));
    await load(prFileDiff("b/src/a.ts"));
    // Same paths but another comparison: the old side of a deletion is another read.
    await load(prFileDiff("b/src/a.ts", "deleted"));

    expect(getDiffFileContents).toHaveBeenCalledTimes(3);
  });

  it("does not pin a file to a transient failure", async () => {
    const failure = new Error("host hiccup");
    const getDiffFileContents = vi.fn(
      async (): Promise<AtomCommandResult<PullRequestDiffFileContentsResult, Error>> =>
        AsyncResult.failure(Cause.fail(failure)),
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    await expect(load(prFileDiff())).rejects.toBe(failure);
    getDiffFileContents.mockImplementation(async () =>
      AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: "before\n",
        newContents: "after\n",
      }),
    );

    await expect(load(prFileDiff())).resolves.toMatchObject({
      newFile: { name: "src/file.ts", contents: "after\n" },
    });
    expect(getDiffFileContents).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently expanded file past the entry cap", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: "before\n",
        newContents: "after\n",
      }),
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    for (let index = 0; index < PULL_REQUEST_FILE_CONTENTS_CACHE_MAX_ENTRIES + 1; index += 1) {
      await load(prFileDiff(`b/src/file-${index}.ts`));
    }
    // file-0 fell out; file-1 is still held.
    await load(prFileDiff("b/src/file-1.ts"));
    await load(prFileDiff("b/src/file-0.ts"));

    expect(getDiffFileContents).toHaveBeenCalledTimes(
      PULL_REQUEST_FILE_CONTENTS_CACHE_MAX_ENTRIES + 2,
    );
    // file-1 survived file-0's return only with recency: FIFO would have dropped file-1 to
    // make room for file-0, so this re-read stays free on LRU and costs one RPC on FIFO.
    await load(prFileDiff("b/src/file-1.ts"));
    expect(getDiffFileContents).toHaveBeenCalledTimes(
      PULL_REQUEST_FILE_CONTENTS_CACHE_MAX_ENTRIES + 2,
    );
  });

  it("carries the revision key into each file so a base advance busts the render cache", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: "before\n",
        newContents: "after\n",
      }),
    );
    // The `:behindN` suffix is folded into the revision key upstream (PullRequestCodeTab);
    // the loader stays opaque to it, but the per-file keys Pierre hydrates against must
    // differ when it moves, or the previous base side would be served as this one's.
    const loadBehind = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
      ...PR_SOURCE,
      cacheKey: `${PR_SOURCE.cacheKey}:behind5`,
    });
    const loadAhead = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
      ...PR_SOURCE,
      cacheKey: `${PR_SOURCE.cacheKey}:behind2`,
    });

    const behind = await loadBehind(prFileDiff());
    const ahead = await loadAhead(prFileDiff());

    expect(behind.newFile?.cacheKey).toContain(":behind5:");
    expect(ahead.newFile?.cacheKey).toContain(":behind2:");
    expect(behind.newFile?.cacheKey).not.toBe(ahead.newFile?.cacheKey);
  });

  it("evicts by total size before the entry cap fills", async () => {
    // One shared side keeps the test cheap: the cap counts lengths, not allocations, and two
    // entries at ~2/3 of the cap each already exceed it with only two files held (cap is 30).
    const side = "x".repeat(Math.floor(PULL_REQUEST_FILE_CONTENTS_CACHE_MAX_BYTES / 3));
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: side,
        newContents: side,
      }),
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    await load(prFileDiff("b/src/big-a.ts"));
    await load(prFileDiff("b/src/big-b.ts"));
    expect(getDiffFileContents).toHaveBeenCalledTimes(2);
    // Two entries are far below the entry cap, so a miss here proves the size arm evicted.
    await load(prFileDiff("b/src/big-a.ts"));
    expect(getDiffFileContents).toHaveBeenCalledTimes(3);
  });
});
