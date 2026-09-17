import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";

import {
  type PendingReviewComment,
  pullRequestReviewKey,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

function comment(id: string, body = id): PendingReviewComment {
  return { id, body, path: "src/app.ts", position: { kind: "added", newLine: 1 } };
}

describe("pull request review drafts", () => {
  beforeEach(() => {
    usePullRequestReviewStore.setState({
      drafts: {},
      summaries: {},
      revisions: {},
      submissions: {},
      submissionAttempts: {},
      inFlight: {},
    });
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

  it("keeps the original diff revision and rejects comments from a moved head", () => {
    const store = usePullRequestReviewStore.getState();
    const original = { version: 1 as const, headOid: "head-a", baseOid: "base" };
    const moved = { version: 1 as const, headOid: "head-b", baseOid: "base" };

    expect(store.addComment("review-a", comment("first"), original)).toBe(true);
    expect(store.addComment("review-a", comment("stale"), moved)).toBe(false);

    expect(usePullRequestReviewStore.getState().drafts["review-a"]).toEqual([comment("first")]);
    expect(usePullRequestReviewStore.getState().revisions["review-a"]).toEqual(original);
  });

  it("retains the exact unsettled A submission across edited B and retry A", () => {
    const store = usePullRequestReviewStore.getState();
    const revisionA = { version: 1 as const, headOid: "head-a", baseOid: "base-a" };
    const first = store.startSubmission("review-a", {
      verdict: "comment",
      body: "A",
      comments: [comment("a")],
      revision: revisionA,
    });
    const concurrent = store.startSubmission("review-a", {
      verdict: "approve",
      body: "B",
      comments: [comment("b")],
      revision: { version: 2, headOid: "head-b", baseOid: "base-b" },
    });

    expect(concurrent).toBeUndefined();
    expect(first?.submission).toMatchObject({
      body: "A",
      comments: [comment("a")],
      revision: revisionA,
    });
    store.finishSubmissionAttempt("review-a", first!.submission.id);
    const attemptedB = store.startSubmission("review-a", {
      verdict: "approve",
      body: "B",
      comments: [comment("b")],
    });
    expect(attemptedB?.submission).toEqual(first?.submission);
    expect(attemptedB?.firstAttempt).toBe(false);
    store.clearSubmission("review-a", "not-the-original-id");
    store.clearSubmission("review-a", first!.submission.id);
    expect(usePullRequestReviewStore.getState().submissions["review-a"]).toBeUndefined();
  });
});
