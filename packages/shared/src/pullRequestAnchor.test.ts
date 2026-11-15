import { expect, it } from "vite-plus/test";
import {
  parsePullRequestAnchor,
  pullRequestAnchorMatchesUrl,
  pullRequestDiffPathMatches,
  pullRequestLinkCommit,
  resolvePullRequestAnchorRange,
  resolvePullRequestReviewAnchor,
} from "./pullRequestAnchor.ts";

const gitlab = "https://gitlab.com/group/repo/-/merge_requests/7";

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
    "f3f78c2026bd34f4ad36bf36e9c557dd9df528fb",
  ],
  [
    "src/日本語.ts",
    "5c66d5d565666e46924cf80d7bbfdab3",
    "191b8ebf2241225db999eaf8b6ff44b07934d577f347d0ff684591eecad34944",
    "2ec8ce696c4c6df9419ad640fbc0d6ef4d79ebad",
  ],
  [
    "old/path.ts",
    "f5d455478d496859b654884654393a61",
    "aa38d67014e2c59d51ea456a155e039f4e32f636a4c450714c3b517bb8bde7e7",
    "ca0d69af01140f25bafd6ab7aec204ce52a9bbb3",
  ],
])("matches GitHub and GitLab path digests for %s", (path, legacy, current, gitLab) => {
  for (const digest of [legacy, current, gitLab, gitLab.slice(0, 9)]) {
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
  const sha = "c".repeat(40);
  for (const anchor of [
    `${sha}_0_0`,
    `${sha}_1_9999999999999999999`,
    `line_${sha.slice(0, 9)}_0`,
  ]) {
    expect(parsePullRequestAnchor(`${gitlab}/diffs#${anchor}`)).toMatchObject({ range: null });
  }
  expect(parsePullRequestAnchor(`${gitlab}/diffs#${sha}_0_5`)).toEqual({
    kind: "diff",
    digest: sha,
    range: { start: 5, side: "right", end: 5, endSide: "right" },
  });
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
  expect(pullRequestLinkCommit(`${gitlab}/diffs?commit_id=${sha}#${"b".repeat(40)}`)).toBe(sha);
  expect(pullRequestLinkCommit(`${gitlab}/diffs?commit_id=main`)).toBeNull();
  expect(pullRequestLinkCommit(`${gitlab}?commit_id=${sha}`)).toBeNull();
});

it("reads GitLab file and line anchors, letting a removed old line win", () => {
  const digest = "c".repeat(40);
  const diff = (range: object | null, at = digest) => ({ kind: "diff", digest: at, range });
  const line = (start: number, side: "left" | "right") => ({
    start,
    side,
    end: start,
    endSide: side,
  });
  expect(parsePullRequestAnchor(`${gitlab}/diffs#${digest}`)).toEqual(diff(null));
  expect(parsePullRequestAnchor(`${gitlab}/diffs#diff-content-${digest}`)).toEqual(diff(null));
  expect(parsePullRequestAnchor(`${gitlab}/diffs?file=${digest}`)).toEqual(diff(null));
  expect(parsePullRequestAnchor(`${gitlab}/diffs?file=${digest}#note_5`)).toEqual({
    kind: "timeline",
    anchor: "note_5",
  });
  const code = parsePullRequestAnchor(`${gitlab}/diffs#${digest}_248_253`);
  expect(code).toEqual(diff({ ...line(253, "right"), oldLine: 248 }));
  const range = code?.kind === "diff" ? code.range : null;
  expect(resolvePullRequestAnchorRange(range!, () => false)).toBe(range);
  expect(resolvePullRequestAnchorRange(range!, (old) => old === 248)).toEqual(line(248, "left"));
  expect(parsePullRequestAnchor(`${gitlab}/diffs#${digest}_12_0`)).toEqual(diff(line(12, "left")));
  expect(parsePullRequestAnchor(`${gitlab}/diffs#line_${digest.slice(0, 9)}_A12`)).toEqual(
    diff(line(12, "right"), digest.slice(0, 9)),
  );
  expect(parsePullRequestAnchor(`${gitlab}/diffs#line_${digest.slice(0, 9)}_12`)).toEqual(
    diff(line(12, "left"), digest.slice(0, 9)),
  );
  expect(parsePullRequestAnchor(`${gitlab}#${digest}_248_253`)).toEqual(code);
  expect(parsePullRequestAnchor(`${gitlab}#${digest}`)).toEqual(diff(null));
  expect(parsePullRequestAnchor(`${gitlab}?file=${digest}`)).toBeNull();
});

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
