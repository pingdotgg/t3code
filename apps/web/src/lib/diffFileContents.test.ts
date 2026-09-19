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
    prevName: "src/old-name.ts",
    name: "src/new-name.ts",
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

function prFileDiff(name = "src/file.ts", type: FileDiffMetadata["type"] = "change") {
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

    await load(prFileDiff("src/a.ts"));
    await load(prFileDiff("src/b.ts"));
    await load(prFileDiff("src/a.ts"));
    // Same paths but another comparison: the old side of a deletion is another read.
    await load(prFileDiff("src/a.ts", "deleted"));

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
      await load(prFileDiff(`src/file-${index}.ts`));
    }
    // file-0 fell out; file-1 is still held.
    await load(prFileDiff("src/file-1.ts"));
    await load(prFileDiff("src/file-0.ts"));

    expect(getDiffFileContents).toHaveBeenCalledTimes(
      PULL_REQUEST_FILE_CONTENTS_CACHE_MAX_ENTRIES + 2,
    );
    // file-1 survived file-0's return only with recency: FIFO would have dropped file-1 to
    // make room for file-0, so this re-read stays free on LRU and costs one RPC on FIFO.
    await load(prFileDiff("src/file-1.ts"));
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

  it("busts settled entries when a read echoes new revisions", async () => {
    // The revision key rides lagging queries, so a push or base replacement can land
    // without rebuilding this loader. The first read served from the new comparison
    // busts entries settled under the old one; without the echo the old file would stand.
    let revision = { baseSha: "base-1", headSha: "head-1" };
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: `before@${revision.headSha}\n`,
        newContents: `after@${revision.headSha}\n`,
        ...revision,
      }),
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    await expect(load(prFileDiff("src/a.ts"))).resolves.toMatchObject({
      newFile: { contents: "after@head-1\n" },
    });
    revision = { baseSha: "base-1", headSha: "head-2" };
    await expect(load(prFileDiff("src/b.ts"))).resolves.toMatchObject({
      newFile: { contents: "after@head-2\n" },
    });
    // Settled under head-1, busted by b.ts's read: a.ts walks again and serves head-2.
    await expect(load(prFileDiff("src/a.ts"))).resolves.toMatchObject({
      newFile: { contents: "after@head-2\n" },
    });
    expect(getDiffFileContents).toHaveBeenCalledTimes(3);
  });

  it("busts on a base-only move at the same head", async () => {
    // The motivating same-count case: the base is replaced without a new head commit, so
    // the commit set (and any `:behindN` count the host kept) does not move. Only the
    // echo sees it.
    let revision = { baseSha: "base-1", headSha: "head-1" };
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: `before@${revision.baseSha}\n`,
        newContents: "after\n",
        ...revision,
      }),
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    await expect(load(prFileDiff("src/a.ts"))).resolves.toMatchObject({
      oldFile: { contents: "before@base-1\n" },
    });
    revision = { baseSha: "base-2", headSha: "head-1" };
    await load(prFileDiff("src/b.ts"));
    await expect(load(prFileDiff("src/a.ts"))).resolves.toMatchObject({
      oldFile: { contents: "before@base-2\n" },
    });
    expect(getDiffFileContents).toHaveBeenCalledTimes(3);
  });

  it("keeps the newer revision when concurrent reads resolve out of order", async () => {
    // A push lands mid-expansion: the older read resolves after the newer one. The older
    // caller still gets what the host served it, but the memo stays on the newer
    // comparison instead of stepping back.
    const echoByPath = new Map([
      ["src/a.ts", { baseSha: "base-1", headSha: "head-1" }],
      ["src/b.ts", { baseSha: "base-1", headSha: "head-2" }],
    ]);
    const release = new Map<string, () => void>();
    // Only the opening round is held; refetches answer immediately with the live echo.
    const deferred = new Set(["src/a.ts", "src/b.ts"]);
    const getDiffFileContents = vi.fn(
      (request: {
        input: { newPath: string };
      }): Promise<AtomCommandResult<PullRequestDiffFileContentsResult, Error>> => {
        const echo = echoByPath.get(request.input.newPath) ?? {
          baseSha: "base-1",
          headSha: "head-2",
        };
        const result = AsyncResult.success<PullRequestDiffFileContentsResult>({
          oldContents: "before\n",
          newContents: `after@${echo.headSha}\n`,
          ...echo,
        });
        if (!deferred.has(request.input.newPath)) return Promise.resolve(result);
        deferred.delete(request.input.newPath);
        return new Promise((resolve) => {
          release.set(request.input.newPath, () => resolve(result));
        });
      },
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    const pendingA = load(prFileDiff("src/a.ts"));
    const pendingB = load(prFileDiff("src/b.ts"));
    // Newer resolves first, older lands late.
    release.get("src/b.ts")?.();
    await pendingB;
    release.get("src/a.ts")?.();
    await expect(pendingA).resolves.toMatchObject({
      newFile: { contents: "after@head-1\n" },
    });
    // Newer stayed settled; the late older read was served without storing.
    await expect(load(prFileDiff("src/b.ts"))).resolves.toMatchObject({
      newFile: { contents: "after@head-2\n" },
    });
    expect(getDiffFileContents).toHaveBeenCalledTimes(2);
    // The world moved on: a refetch now serves the newer comparison and busts to it.
    echoByPath.set("src/a.ts", { baseSha: "base-1", headSha: "head-2" });
    await expect(load(prFileDiff("src/a.ts"))).resolves.toMatchObject({
      newFile: { contents: "after@head-2\n" },
    });
    expect(getDiffFileContents).toHaveBeenCalledTimes(3);
  });

  it("leaves the established revision intact when a later read fails", async () => {
    const failure = new Error("host hiccup");
    let shouldFail = false;
    const getDiffFileContents = vi.fn(async () =>
      shouldFail
        ? AsyncResult.failure<PullRequestDiffFileContentsResult, Error>(Cause.fail(failure))
        : AsyncResult.success<PullRequestDiffFileContentsResult>({
            oldContents: "before\n",
            newContents: "after\n",
            baseSha: "base-1",
            headSha: "head-1",
          }),
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    await load(prFileDiff("src/a.ts"));
    shouldFail = true;
    await expect(load(prFileDiff("src/b.ts"))).rejects.toBe(failure);
    shouldFail = false;
    // The failed read touched neither the memo nor the revision: a.ts stays settled.
    await load(prFileDiff("src/a.ts"));
    expect(getDiffFileContents).toHaveBeenCalledTimes(2);
  });

  it("keeps the memo when the echoed revisions do not move", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: "before\n",
        newContents: "after\n",
        baseSha: "base-1",
        headSha: "head-1",
      }),
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    await load(prFileDiff("src/a.ts"));
    await load(prFileDiff("src/b.ts"));
    await load(prFileDiff("src/a.ts"));

    expect(getDiffFileContents).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy behavior where the server echoes no revisions", async () => {
    // Older servers answer contents alone: nothing to compare, so nothing to bust on —
    // the revision key upstream stays the only gate, exactly as before.
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: "before\n",
        newContents: "after\n",
      }),
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    await load(prFileDiff("src/a.ts"));
    await load(prFileDiff("src/b.ts"));
    await load(prFileDiff("src/a.ts"));

    expect(getDiffFileContents).toHaveBeenCalledTimes(2);
  });

  it("supersedes an in-flight read predated by an established revision", async () => {
    // A new expansion joining file A's still-flying revision-1 read would be served
    // known-stale content. Once file B establishes revision 2, the new request starts a
    // fresh read instead of joining; the late revision-1 landing still serves its own
    // caller without storing.
    const echoByPath = new Map([
      ["src/a.ts", { baseSha: "base-1", headSha: "head-1" }],
      ["src/b.ts", { baseSha: "base-1", headSha: "head-2" }],
    ]);
    const release = new Map<string, () => void>();
    const deferred = new Set(["src/a.ts", "src/b.ts"]);
    const getDiffFileContents = vi.fn(
      (request: {
        input: { newPath: string };
      }): Promise<AtomCommandResult<PullRequestDiffFileContentsResult, Error>> => {
        const echo = echoByPath.get(request.input.newPath) ?? {
          baseSha: "base-1",
          headSha: "head-2",
        };
        const result = AsyncResult.success<PullRequestDiffFileContentsResult>({
          oldContents: "before\n",
          newContents: `after@${echo.headSha}\n`,
          ...echo,
        });
        if (!deferred.has(request.input.newPath)) return Promise.resolve(result);
        deferred.delete(request.input.newPath);
        return new Promise((resolve) => {
          release.set(request.input.newPath, () => resolve(result));
        });
      },
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    const stale = load(prFileDiff("src/a.ts"));
    const establishing = load(prFileDiff("src/b.ts"));
    release.get("src/b.ts")?.();
    await establishing;
    // The world moved on before the replacement read: it serves the new comparison.
    echoByPath.set("src/a.ts", { baseSha: "base-1", headSha: "head-2" });
    const replacement = load(prFileDiff("src/a.ts"));
    expect(getDiffFileContents).toHaveBeenCalledTimes(3);
    release.get("src/a.ts")?.();
    await expect(stale).resolves.toMatchObject({
      newFile: { contents: "after@head-1\n" },
    });
    await expect(replacement).resolves.toMatchObject({
      newFile: { contents: "after@head-2\n" },
    });
    // The replacement settled; the stale landing stored nothing.
    await expect(load(prFileDiff("src/a.ts"))).resolves.toMatchObject({
      newFile: { contents: "after@head-2\n" },
    });
    expect(getDiffFileContents).toHaveBeenCalledTimes(3);
  });

  it("keys hydrated files by served revision, legacy shape without echo", async () => {
    // Pierre treats FileContents.cacheKey as a revision identity for worker-pool caching
    // and hydration reuse: the same file served from two comparisons must key
    // differently, or highlights from the previous revision are reused for the new one.
    let revision = { baseSha: "base-1", headSha: "head-1" };
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: "before\n",
        newContents: "after\n",
        ...revision,
      }),
    );
    const load = createPullRequestDiffFileContentsLoader(getDiffFileContents, PR_SOURCE);

    const first = await load(prFileDiff());
    expect(first.newFile?.cacheKey).toBe(`${PR_SOURCE.cacheKey}:new:src/file.ts:base-1@head-1`);
    expect(first.oldFile?.cacheKey).toBe(`${PR_SOURCE.cacheKey}:old:src/file.ts:base-1@head-1`);
    revision = { baseSha: "base-1", headSha: "head-2" };
    const second = await load(prFileDiff("src/other.ts"));
    expect(second.newFile?.cacheKey).toBe(`${PR_SOURCE.cacheKey}:new:src/other.ts:base-1@head-2`);

    // No echo (older server): exactly the historical shape, so existing highlights keep
    // hitting.
    const legacyContents = vi.fn(async () =>
      AsyncResult.success<PullRequestDiffFileContentsResult>({
        oldContents: "before\n",
        newContents: "after\n",
      }),
    );
    const legacy = createPullRequestDiffFileContentsLoader(legacyContents, PR_SOURCE);
    const legacyFirst = await legacy(prFileDiff());
    expect(legacyFirst.newFile?.cacheKey).toBe(`${PR_SOURCE.cacheKey}:new:src/file.ts`);
    expect(legacyFirst.oldFile?.cacheKey).toBe(`${PR_SOURCE.cacheKey}:old:src/file.ts`);
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

    await load(prFileDiff("src/big-a.ts"));
    await load(prFileDiff("src/big-b.ts"));
    expect(getDiffFileContents).toHaveBeenCalledTimes(2);
    // Two entries are far below the entry cap, so a miss here proves the size arm evicted.
    await load(prFileDiff("src/big-a.ts"));
    expect(getDiffFileContents).toHaveBeenCalledTimes(3);
  });
});
