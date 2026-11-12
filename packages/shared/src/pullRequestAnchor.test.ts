import { expect, it } from "vite-plus/test";
import {
  parsePullRequestAnchor,
  pullRequestAnchorMatchesUrl,
  pullRequestDiffPathMatches,
  pullRequestLinkCommit,
  resolvePullRequestReviewAnchor,
} from "./pullRequestAnchor.ts";

const url = "https://github.com/owner/repo/pull/7";
it.each(["discussion_r123", "r123", "discussion-diff-123R5-L9", "discussion-diff-123"])(
  "resolves review comment alias %s",
  (hash) => {
    expect(parsePullRequestAnchor(`${url}#${hash}`)).toEqual({
      kind: "timeline",
      anchor: "discussion_r123",
    });
    expect(pullRequestAnchorMatchesUrl("discussion_r123", `${url}#${hash}`)).toBe(true);
  },
);
it.each([
  "pullrequestreview-123",
  "issuecomment-123",
  "commitcomment-123",
  "event-123",
  "note_123",
  "comment-123",
])("preserves timeline anchor %s", (anchor) => {
  expect(parsePullRequestAnchor(`${url}#${anchor}`)).toEqual({ kind: "timeline", anchor });
});
it.each(["a".repeat(32), "b".repeat(64)])(
  "reads file and cross-side line ranges for %s",
  (digest) => {
    expect(parsePullRequestAnchor(`${url}/files#diff-${digest}`)).toEqual({
      kind: "diff",
      digest,
      range: null,
    });
    expect(parsePullRequestAnchor(`${url}/changes#diff-${digest}L12-R15`)).toEqual({
      kind: "diff",
      digest,
      range: { start: 12, side: "left", end: 15, endSide: "right" },
    });
    expect(parsePullRequestAnchor(`${url}#diff-${digest}R42`)).toEqual({
      kind: "diff",
      digest,
      range: { start: 42, side: "right", end: 42, endSide: "right" },
    });
  },
);
it.each([
  [
    "src/hello world.ts",
    "bcea8deb9d67b305e28c4a0b0d021615",
    "066802cf2cf056706e4e4951cb7dff2717a2ae32fd9797c1f1b41062d57db929",
  ],
  [
    "src/日本語.ts",
    "5c66d5d565666e46924cf80d7bbfdab3",
    "191b8ebf2241225db999eaf8b6ff44b07934d577f347d0ff684591eecad34944",
  ],
  [
    "old/path.ts",
    "f5d455478d496859b654884654393a61",
    "aa38d67014e2c59d51ea456a155e039f4e32f636a4c450714c3b517bb8bde7e7",
  ],
])("matches GitHub path digests for %s", (path, legacy, current) => {
  for (const digest of [legacy, current]) {
    expect(pullRequestDiffPathMatches(digest, path)).toBe(true);
    expect(pullRequestDiffPathMatches(digest, "other.ts")).toBe(false);
  }
});
it("handles encoded hashes and rejects invalid line numbers and URLs", () => {
  expect(parsePullRequestAnchor(`${url}#%64iscussion_r123`)).toEqual({
    kind: "timeline",
    anchor: "discussion_r123",
  });
  expect(parsePullRequestAnchor(`${url}#diff-abcR0`)).toBeNull();
  expect(parsePullRequestAnchor(`${url}#diff-abcR9999999999999999999`)).toBeNull();
  expect(parsePullRequestAnchor("invalid")).toBeNull();
  expect(parsePullRequestAnchor(url)).toBeNull();
  expect(parsePullRequestAnchor(`${url}#unknown`)).toEqual({ kind: "summary", anchor: "unknown" });
  expect(parsePullRequestAnchor(`${url}/files-not-a-tab`)).toBeNull();
  expect(parsePullRequestAnchor(`${url}/commits/main`)).toBeNull();
  expect(parsePullRequestAnchor(`${url}/checks/extra`)).toBeNull();
});

it("keeps the commit scope of a PR diff permalink", () => {
  const sha = "a".repeat(40);
  expect(pullRequestLinkCommit(`${url}/commits/${sha}#diff-abcR5`)).toBe(sha);
  expect(pullRequestLinkCommit(`${url}/files#diff-abcR5`)).toBeNull();
});

const gitlab = "https://gitlab.com/group/repo/-/merge_requests/7";
it.each([
  [`${url}/files`, "code"],
  [`${url}/files/`, "code"],
  [`${url}/changes`, "code"],
  [`${url}/commits/${"a".repeat(40)}`, "code"],
  [`${url}/commits`, "commits"],
  [`${url}/checks?check_run_id=1`, "checks"],
  [`${gitlab}/diffs`, "code"],
  [`${gitlab}/commits`, "commits"],
  [`${gitlab}/pipelines`, "checks"],
] as const)("keeps unknown and missing hashes in the tab %s names", (path, kind) => {
  for (const hash of ["", "#unknown", "#diff-abcR0", "#diff-abcR9999999999999999999", "#%ZZ"]) {
    expect(parsePullRequestAnchor(`${path}${hash}`)).toEqual({ kind });
  }
  expect(parsePullRequestAnchor(`${path}#issuecomment-123`)).toEqual({
    kind: "timeline",
    anchor: "issuecomment-123",
  });
});

it("finds a review with no text of its own through the earliest comment it posted", () => {
  const review = `${url}#pullrequestreview-9`;
  const threads = [
    {
      comments: [
        { url: `${url}#discussion_r3`, createdAt: "2026-07-01T00:02:00Z", reviewUrl: review },
        { url: `${url}#discussion_r2`, createdAt: "2026-07-01T00:01:00Z", reviewUrl: review },
        { url: `${url}#discussion_r1`, createdAt: "2026-07-01T00:00:00Z" },
      ],
    },
  ];
  expect(resolvePullRequestReviewAnchor("pullrequestreview-9", [], threads)).toBe("discussion_r2");
  // A review shown in its own right, an unknown review and other anchors are kept.
  expect(resolvePullRequestReviewAnchor("pullrequestreview-9", [{ url: review }], threads)).toBe(
    "pullrequestreview-9",
  );
  expect(resolvePullRequestReviewAnchor("pullrequestreview-8", [], threads)).toBe(
    "pullrequestreview-8",
  );
  expect(resolvePullRequestReviewAnchor("issuecomment-9", [], threads)).toBe("issuecomment-9");
});

it("reads GitLab merge request file and line anchors", () => {
  const path = "internal/commands/issuable/view/issuable_view_test.go";
  const digest = "0cd3702f060909d3161d1095b8347d4d07671427";
  expect(pullRequestDiffPathMatches(digest, path)).toBe(true);
  expect(parsePullRequestAnchor(`${gitlab}/diffs#${digest}`)).toEqual({
    kind: "diff",
    digest,
    range: null,
  });
  expect(parsePullRequestAnchor(`${gitlab}/diffs#${digest}_248_253`)).toEqual({
    kind: "diff",
    digest,
    range: { start: 253, side: "right", end: 253, endSide: "right" },
  });
  expect(parsePullRequestAnchor(`${gitlab}/diffs#${digest}_12_0`)).toMatchObject({
    range: { start: 12, side: "left" },
  });
});
