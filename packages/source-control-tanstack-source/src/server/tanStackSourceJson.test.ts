import { describe, expect, it } from "vite-plus/test";

import * as Json from "./tanStackSourceJson.ts";

const HOST = "source.tanstack.com";
const run = (fields: Partial<Json.SourceCheckRun> & { readonly name: string }) => ({
  view: "full",
  status: "completed",
  conclusion: "success",
  startedAt: 1,
  completedAt: 2,
  summary: null,
  ...fields,
});

describe("toChecks", () => {
  // Shapes from `GET /check-runs?sha=` on TanStack/ai: Source CI jobs carry a job id, checks
  // synced from GitHub a url and a source.
  const job: Json.SourceCiJob = {
    runId: "b524c952-431d-885f-255c-bf2fbf8addb2",
    workflow: "pr",
    key: "test (shard: 1)",
    runUrl: `https://${HOST}/@TanStack/ai/ci/b524c952-431d-885f-255c-bf2fbf8addb2`,
  };

  it("names Source CI jobs by workflow, links their log, and keeps a re-run's newest result", () => {
    const checks = Json.toChecks({
      runs: [
        run({ jobId: "old", name: "test (shard: 1)", conclusion: "failure", startedAt: 1 }),
        // A job Source CI has not reported a run for yet still shows, under its own name.
        run({ jobId: "unread", name: "lint", conclusion: "failure", startedAt: 0 }),
        run({ jobId: "new", name: "test (shard: 1)", startedAt: 5, summary: "### Passed\nmore" }),
        run({
          jobId: "",
          name: "CodeRabbit",
          status: "in_progress",
          conclusion: null,
          url: "https://coderabbit.ai",
          source: "github",
        }),
      ],
      jobs: new Map([
        ["old", job],
        ["new", job],
      ]),
      required: new Set(["pr/test (shard: 1)"]),
    });
    expect(checks).toEqual(
      expect.arrayContaining([
        {
          name: "pr/test (shard: 1)",
          status: "success",
          description: "Passed",
          url: `${job.runUrl}?job=test+%28shard%3A+1%29`,
          required: true,
        },
        { name: "CodeRabbit", status: "pending", description: null, url: "https://coderabbit.ai" },
        { name: "lint", status: "failure", description: null, url: null },
      ]),
    );
    expect(checks).toHaveLength(3);
    expect(Json.checksStateOf(checks)).toBe("failing");
    expect(Json.parseCiJobUrl(checks.find((check) => check.required)!.url, HOST)).toEqual({
      runId: job.runId,
      job: job.key,
    });
    expect(Json.parseCiJobUrl("https://coderabbit.ai", HOST)).toBeNull();
  });
});

describe("toReviewComment", () => {
  it("anchors added and right-side lines on new, deleted and left-side lines on old", () => {
    const draft = (position: Parameters<typeof Json.toReviewComment>[0]["position"]) =>
      Json.toReviewComment({ path: "a.ts", position, body: "x" }, "sha");
    expect(draft({ kind: "added", newLine: 4 })).toMatchObject({ side: "new", line: 4 });
    expect(draft({ kind: "deleted", oldLine: 3 })).toMatchObject({ side: "old", line: 3 });
    expect(draft({ kind: "context", oldLine: 3, newLine: 5, side: "left" })).toMatchObject({
      side: "old",
      line: 3,
    });
    expect(
      Json.toReviewComment(
        {
          path: "a.ts",
          startPosition: { kind: "added", newLine: 2 },
          position: { kind: "added", newLine: 4 },
          body: "x",
        },
        "sha",
      ),
    ).toEqual({ path: "a.ts", side: "new", line: 4, startLine: 2, commitId: "sha", body: "x" });
  });
});

describe("toActivity", () => {
  it("tells conversation comments, line comments and reviews apart, and hides held ones", () => {
    const activity = Json.toActivity({
      timeline: {
        timeline: [
          { id: 1, comment: "hi", author: "alice", at: 1_000, moderation: "visible" },
          { id: 2, comment: null, author: "spam", at: 2_000, moderation: "quarantined" },
          { id: 3, comment: "LGTM", author: "bob", at: 3_000, review: "approved" },
          { id: 4, comment: "nit", author: "bob", at: 3_000, path: "a.ts", reviewId: 3 },
        ],
        next: null,
      },
      threads: [
        {
          id: 4,
          path: "a.ts",
          side: "old",
          line: 2,
          outdated: false,
          resolved: true,
          comments: [{ id: 4, comment: "nit", author: "bob", at: 3_000 }],
        },
      ],
      commits: {
        baseSha: null,
        headSha: null,
        mergeBaseSha: null,
        available: true,
        commitsTruncated: false,
        commits: [{ sha: "abc", title: "fix", author: { name: "Bob", timestamp: 3 } }],
      },
      host: HOST,
      repository: "TanStack/ai",
      number: 9,
    });
    expect(
      activity.comments.map((comment) => [comment.id, comment.kind, comment.reviewState]),
    ).toEqual([
      ["1", "issue-comment", null],
      ["3", "review", "approved"],
      ["4", "review-comment", null],
    ]);
    expect(activity.comments[0]?.url).toBe(`https://${HOST}/@TanStack/ai/pull/9#comment-1`);
    expect(Json.pullUrl(HOST, "%40TanStack/ai", 9)).toBe(`https://${HOST}/@TanStack/ai/pull/9`);
    expect(activity.reviewThreads).toMatchObject([
      { id: "4", path: "a.ts", line: 2, side: "left", isResolved: true },
    ]);
    expect(activity.commits).toEqual([
      { oid: "abc", messageHeadline: "fix", committedDate: "1970-01-01T00:00:03.000Z" },
    ]);
  });
});
