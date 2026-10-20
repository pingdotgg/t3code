import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ProjectId, type PullRequestReviewThread } from "@t3tools/contracts";

import {
  mergePendingReviewComments,
  type PendingReviewComment,
  pullRequestReviewKey,
  savePendingReviewComment,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

function comment(id: string, body = id): PendingReviewComment {
  return { id, body, path: "src/app.ts", position: { kind: "added", newLine: 1 } };
}

function pendingSave() {
  let resolve!: (hosted: NonNullable<PendingReviewComment["hostedComment"]>) => void;
  const promise = new Promise<NonNullable<PendingReviewComment["hostedComment"]>>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function hostedThread(pending = true): PullRequestReviewThread {
  return {
    id: "thread",
    path: "src/app.ts",
    line: 1,
    side: "right",
    isResolved: false,
    isOutdated: false,
    comments: [
      {
        id: "remote",
        author: null,
        body: "remote",
        createdAt: "2026-10-14T16:00:00Z",
        url: "https://github.com/owner/repo/pull/7/changes#r1",
        ...(pending ? { pendingReviewId: "review" } : {}),
      },
    ],
  };
}

describe("pull request review drafts", () => {
  beforeEach(() => {
    usePullRequestReviewStore.setState({
      drafts: {},
      summaries: {},
      removedHostComments: {},
      busyComments: {},
    });
  });

  it("saves concurrent additions as private host drafts and suppresses a duplicate in-flight save", async () => {
    const store = usePullRequestReviewStore.getState();
    store.addComment("review-a", comment("first"));
    store.addComment("review-a", comment("second"));
    const first = pendingSave();
    const second = pendingSave();
    const one = savePendingReviewComment("review-a", comment("first"), () => first.promise);
    const two = savePendingReviewComment("review-a", comment("second"), () => second.promise);
    expect(usePullRequestReviewStore.getState().busyComments["review-a"]).toEqual([
      "first",
      "second",
    ]);
    expect(
      await savePendingReviewComment("review-a", comment("first"), () => {
        throw new Error("duplicate request");
      }),
    ).toBeNull();
    first.resolve({
      reviewId: "review",
      commentId: "host-first",
      url: "https://github.com/o/r/pull/1#r1",
    });
    await one;
    expect(usePullRequestReviewStore.getState().busyComments["review-a"]).toEqual(["second"]);
    second.resolve({
      reviewId: "review",
      commentId: "host-second",
      url: "https://github.com/o/r/pull/1#r2",
    });
    await two;
    expect(
      usePullRequestReviewStore
        .getState()
        .drafts["review-a"]?.map((entry) => entry.hostedComment?.commentId),
    ).toEqual(["host-first", "host-second"]);
  });

  it("keeps a failed draft for retry and reuses a saved host identity without another request", async () => {
    const local = comment("failed", "Keep this feedback");
    usePullRequestReviewStore.getState().addComment("review-a", local);
    await expect(
      savePendingReviewComment("review-a", local, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(usePullRequestReviewStore.getState().drafts["review-a"]).toEqual([local]);
    expect(usePullRequestReviewStore.getState().busyComments["review-a"]).toEqual([]);
    const hosted = {
      reviewId: "review",
      commentId: "host",
      url: "https://github.com/o/r/pull/1#r1",
    };
    expect(await savePendingReviewComment("review-a", local, async () => hosted)).toEqual(hosted);
    expect(
      await savePendingReviewComment("review-a", local, () => {
        throw new Error("already saved");
      }),
    ).toEqual(hosted);
  });

  it("removes only the line comments included in a submitted snapshot", () => {
    const store = usePullRequestReviewStore.getState();
    store.addComment("review-a", comment("submitted"));
    const submittedIds =
      usePullRequestReviewStore.getState().drafts["review-a"]?.map((entry) => entry.id) ?? [];

    usePullRequestReviewStore.getState().addComment("review-a", comment("added-in-flight"));
    usePullRequestReviewStore.getState().removeComments("review-a", submittedIds);

    expect(usePullRequestReviewStore.getState().drafts["review-a"]).toEqual([
      comment("added-in-flight"),
    ]);
  });

  it("does not resurrect a removed hosted draft from a stale host snapshot", () => {
    const saved = {
      ...comment("local"),
      hostedComment: {
        reviewId: "review",
        commentId: "remote",
        url: "https://github.com/owner/repo/pull/7/changes#r1",
      },
    };
    const store = usePullRequestReviewStore.getState();
    store.addComment("review-a", saved);
    store.removeComments("review-a", [saved.id]);
    expect(usePullRequestReviewStore.getState().removedHostComments["review-a"]).toEqual([
      "remote",
    ]);
    expect(mergePendingReviewComments([saved], [hostedThread()], ["remote"])).toEqual([]);
    expect(mergePendingReviewComments([saved], [hostedThread(false)], [])).toEqual([]);
    expect(mergePendingReviewComments([saved, comment("new")], [], ["remote"])).toEqual([
      comment("new"),
    ]);
  });

  it("records remote-only removals when no local draft was ever added", () => {
    usePullRequestReviewStore.getState().removeComments("review-a", ["remote"], ["remote"]);
    expect(usePullRequestReviewStore.getState().removedHostComments["review-a"]).toEqual([
      "remote",
    ]);
    expect(usePullRequestReviewStore.getState().drafts["review-a"]).toBeUndefined();
  });

  it("keeps summary bodies isolated by review key", () => {
    const store = usePullRequestReviewStore.getState();
    store.setSummary("review-a", "Summary A");
    store.setSummary("review-b", "Summary B");
    store.clearSummary("review-a", "Summary A");

    expect(usePullRequestReviewStore.getState().summaries).toEqual({
      "review-b": "Summary B",
    });
  });

  it("keeps drafts on different hosts separate when a thread reviews the same repository and number", () => {
    const reference = {
      projectId: ProjectId.make("project-a"),
      repository: "owner/repo",
      number: 7,
    };
    const publicKey = pullRequestReviewKey({ ...reference, host: "github.com" });
    const enterpriseKey = pullRequestReviewKey({ ...reference, host: "github.example.com" });
    const store = usePullRequestReviewStore.getState();
    store.addComment(publicKey, comment("public"));
    store.setSummary(publicKey, "Public review");

    expect(usePullRequestReviewStore.getState().drafts[enterpriseKey]).toBeUndefined();
    expect(usePullRequestReviewStore.getState().summaries[enterpriseKey]).toBeUndefined();

    store.addComment(enterpriseKey, comment("enterprise"));
    store.setSummary(enterpriseKey, "Enterprise review");
    store.clear(enterpriseKey);
    store.clearSummary(enterpriseKey, "Enterprise review");

    expect(usePullRequestReviewStore.getState().drafts[publicKey]).toEqual([comment("public")]);
    expect(usePullRequestReviewStore.getState().summaries[publicKey]).toBe("Public review");
  });

  it("does not clear a summary revised while submission is in flight", () => {
    const store = usePullRequestReviewStore.getState();
    store.setSummary("review-a", "Submitted body");
    usePullRequestReviewStore.getState().setSummary("review-a", "Revised body");
    usePullRequestReviewStore.getState().clearSummary("review-a", "Submitted body");

    expect(usePullRequestReviewStore.getState().summaries["review-a"]).toBe("Revised body");
  });
});
