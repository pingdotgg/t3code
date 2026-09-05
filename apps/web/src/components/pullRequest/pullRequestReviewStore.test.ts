import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

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
    usePullRequestReviewStore.setState({ drafts: {}, summaries: {} });
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

  it("does not clear a summary revised while submission is in flight", () => {
    const store = usePullRequestReviewStore.getState();
    store.setSummary("review-a", "Submitted body");
    usePullRequestReviewStore.getState().setSummary("review-a", "Revised body");
    usePullRequestReviewStore.getState().clearSummary("review-a", "Submitted body");

    expect(usePullRequestReviewStore.getState().summaries["review-a"]).toBe("Revised body");
  });
});

it("keeps unlinked review drafts and summaries separate across servers", () => {
  usePullRequestReviewStore.setState({ drafts: {}, summaries: {} });
  const reference = { projectId: null, repository: "acme/web", number: 42 };
  const first = pullRequestReviewKey(EnvironmentId.make("server-a"), reference);
  const second = pullRequestReviewKey(EnvironmentId.make("server-b"), reference);
  const store = usePullRequestReviewStore.getState();
  store.addComment(first, comment("first"));
  store.setSummary(first, "Account A review");
  store.addComment(second, comment("second"));
  store.setSummary(second, "Account B review");
  store.clear(first);
  store.clearSummary(first, "Account A review");
  expect(usePullRequestReviewStore.getState().drafts[second]).toEqual([comment("second")]);
  expect(usePullRequestReviewStore.getState().summaries[second]).toBe("Account B review");
});
