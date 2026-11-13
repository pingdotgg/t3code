import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  describe,
  expect,
  it,
} from "vite-plus/test";
import {
  buildReviewSubmission,
  buildReviewerRequest,
  pullRequestLookup,
  toPullRequestWatchFingerprint,
  decodePullRequestFilesJson,
  decodePullRequestStacksJson,
} from "./gitHubPullRequestJson.ts";
import { PullRequestWatchFingerprint } from "./pullRequestBatches.graphql.ts";
import { ReviewThreads } from "./pullRequestReviews.graphql.ts";
import { decodePullRequestFilesViewedJson, decodeReviewerCandidatesJson, expectSuccess, requestedReviewer, row, user } from "./gitHubPullRequestJson.part2.testkit.ts";

describe("ReviewThreads", () => {
  it("caps the initial query after the 104-point rate-limit regression", () => {
    const match = ReviewThreads.document.match(
      /reviewThreads\(first:(\d+)[\s\S]*?\.\.\.ThreadComment[\s\S]*$/u,
    );
    const comments = ReviewThreads.document.match(/comments\(first:(\d+)\)\{totalCount/u);

    expect(match).not.toBeNull();
    expect(comments).not.toBeNull();
    if (match === null || comments === null) throw new Error("expected review-thread connections");
    expect(Number(match[1]) * Number(comments[1])).toBeLessThanOrEqual(1_000);
  });
});

describe("reviewer candidate decoding", () => {
  const candidatesJson = (input: {
    readonly assignable: ReadonlyArray<Record<string, unknown> | null>;
    readonly requested?: ReadonlyArray<Record<string, unknown> | null>;
    readonly author?: string;
    readonly hasNextPage?: boolean;
  }) =>
    JSON.stringify({
      data: {
        repository: {
          assignableUsers: {
            pageInfo: { hasNextPage: input.hasNextPage ?? false },
            nodes: input.assignable.map((node) =>
              node === null ? null : { name: null, avatarUrl: "", ...node },
            ),
          },
          pullRequest: {
            author: input.author === undefined ? null : { __typename: "User", login: input.author },
            reviewRequests: {
              nodes: (input.requested ?? []).map((requestedReviewer) => ({
                requestedReviewer:
                  requestedReviewer === null
                    ? null
                    : "slug" in requestedReviewer
                      ? {
                          __typename: "Team",
                          teamAvatarUrl: null,
                          ...requestedReviewer,
                        }
                      : { __typename: "User", name: null, avatarUrl: "", ...requestedReviewer },
              })),
            },
          },
        },
      },
    });

  it("leaves the author out of the people their own pull request can be sent to", () => {
    const list = expectSuccess(
      decodeReviewerCandidatesJson(
        candidatesJson({
          assignable: [{ login: "bilal" }, { login: "octocat", name: "The Octocat" }],
          author: "bilal",
        }),
      ),
    );
    expect(list.candidates).toEqual([
      {
        id: "octocat",
        kind: "user",
        login: "octocat",
        name: "The Octocat",
        avatarUrl: null,
        isRequested: false,
      },
    ]);
    expect(list.truncated).toBe(false);
  });

  it("keeps a requested team apart from the people, so the request can be taken back", () => {
    const list = expectSuccess(
      decodeReviewerCandidatesJson(
        candidatesJson({
          assignable: [{ login: "octocat" }],
          requested: [{ slug: "reviewers", combinedSlug: "acme/reviewers", teamName: "Reviewers" }],
        }),
      ),
    );
    expect(list.candidates).toEqual([
      {
        id: "reviewers",
        kind: "team",
        login: "acme/reviewers",
        name: "Reviewers",
        avatarUrl: null,
        isRequested: true,
      },
      {
        id: "octocat",
        kind: "user",
        login: "octocat",
        name: null,
        avatarUrl: null,
        isRequested: false,
      },
    ]);
  });
});

describe("reviewer request payload", () => {
  it("sends people and teams in the two lists GitHub keeps them in", () => {
    expect(
      buildReviewerRequest([
        { id: "octocat", kind: "user" },
        { id: "reviewers", kind: "team" },
        { id: "hubot", kind: "user" },
      ]),
    ).toEqual({ reviewers: ["octocat", "hubot"], team_reviewers: ["reviewers"] });
  });

  it("sends both lists even where one of them is empty, which is what GitHub reads", () => {
    expect(buildReviewerRequest([{ id: "octocat", kind: "user" }])).toEqual({
      reviewers: ["octocat"],
      team_reviewers: [],
    });
  });
});

describe("review submission payload", () => {
  it("sends the verdict, the summary and every line comment in one body", () => {
    const payload = buildReviewSubmission({
      verdict: "request-changes",
      body: "Two things.",
      comments: [
        {
          path: "src/a.ts",
          position: { kind: "added", newLine: 12 },
          body: "rename this",
        },
        {
          path: "src/b.ts",
          position: { kind: "deleted", oldLine: 3 },
          body: "why remove?",
        },
      ],
    });
    expect(payload).toEqual({
      event: "REQUEST_CHANGES",
      body: "Two things.",
      comments: [
        { path: "src/a.ts", line: 12, side: "RIGHT", body: "rename this" },
        { path: "src/b.ts", line: 3, side: "LEFT", body: "why remove?" },
      ],
    });
  });

  it("sends a range from its first line, and a one-line range as one line", () => {
    const payload = buildReviewSubmission({
      verdict: "comment",
      body: "",
      comments: [
        {
          path: "src/a.ts",
          startPosition: { kind: "context", oldLine: 4, newLine: 5, side: "right" },
          position: { kind: "added", newLine: 9 },
          body: "this block",
        },
        {
          path: "src/b.ts",
          startPosition: { kind: "added", newLine: 2 },
          position: { kind: "added", newLine: 2 },
          body: "this line",
        },
      ],
    });
    expect(payload.comments).toEqual([
      {
        path: "src/a.ts",
        start_line: 5,
        start_side: "RIGHT",
        line: 9,
        side: "RIGHT",
        body: "this block",
      },
      { path: "src/b.ts", line: 2, side: "RIGHT", body: "this line" },
    ]);
  });
});

describe("decodePullRequestFilesJson", () => {
  it("quotes literal backslashes without interpreting them as escapes", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          {
            filename: String.raw`src\notes.ts`,
            status: "modified",
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        String.raw`diff --git "a/src\\notes.ts" "b/src\\notes.ts"`,
        String.raw`--- "a/src\\notes.ts"`,
        String.raw`+++ "b/src\\notes.ts"`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
  });

  it("preserves spaces and literal backslashes in both rename paths", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          {
            previous_filename: String.raw` old\name.ts `,
            filename: String.raw` new\name.ts `,
            status: "renamed",
          },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        String.raw`diff --git "a/ old\\name.ts " "b/ new\\name.ts "`,
        "similarity index 100%",
        String.raw`rename from " old\\name.ts "`,
        String.raw`rename to " new\\name.ts "`,
        String.raw`--- "a/ old\\name.ts "`,
        String.raw`+++ "b/ new\\name.ts "`,
        "",
      ].join("\n"),
    );
  });

  it("points an added file at /dev/null on the left and a removed one on the right", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          { filename: "src/new.ts", status: "added", patch: "@@ -0,0 +1 @@\n+hello" },
          { filename: "src/gone.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-bye" },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        "diff --git a/src/new.ts b/src/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/new.ts",
        "@@ -0,0 +1 @@",
        "+hello",
        "diff --git a/src/gone.ts b/src/gone.ts",
        "deleted file mode 100644",
        "--- a/src/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        "",
      ].join("\n"),
    );
  });

  it("names both paths of a rename, counting its hunks against the old one", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          {
            filename: "src/new.ts",
            status: "renamed",
            previous_filename: "src/old.ts",
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 0%",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "--- a/src/old.ts",
        "+++ b/src/new.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
  });

  it("still lists a file GitHub sent no hunks for, and says what was withheld", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          { filename: "logo.png", status: "modified", additions: 4, deletions: 2 },
          {
            filename: "src/app.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ]),
      ),
    );

    expect(result.patch).toContain("diff --git a/logo.png b/logo.png");
    expect(result.patch).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(result.truncated).toBe(true);
    expect(result.rawCount).toBe(2);
  });
});

describe("decodePullRequestFilesViewedJson", () => {
  const page = (
    nodes: ReadonlyArray<unknown>,
    pageInfo: { hasNextPage: boolean; endCursor: string | null },
  ) =>
    JSON.stringify({
      data: { repository: { pullRequest: { files: { pageInfo, nodes } } } },
    });

  it("treats a state it has never heard of as unread rather than failing the page", () => {
    const decoded = decodePullRequestFilesViewedJson(
      page([{ path: "src/a.ts", viewerViewedState: "SOMETHING_NEW" }], {
        hasNextPage: false,
        endCursor: null,
      }),
    );
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success).toEqual({
      files: [{ path: "src/a.ts", state: "unviewed" }],
      nextCursor: null,
    });
  });
});

describe("host-native stack decoding", () => {
  function stack(overrides: Record<string, unknown> = {}) {
    return {
      id: 42,
      number: 3,
      node_id: "STK_kwDO",
      url: "https://api.github.com/repos/acme/web/stacks/3",
      base: { ref: "main", sha: "abc" },
      open: true,
      created_at: "2026-09-01T00:00:00Z",
      pull_requests: [
        {
          number: 10,
          head: { ref: "feat/one" },
          state: "closed",
          merged_at: "2026-09-02T00:00:00Z",
        },
        { number: 11, head: { ref: "feat/two" }, state: "open", merged_at: null },
        { number: 12, head: { ref: "feat/three" }, state: "closed", merged_at: null },
      ],
      ...overrides,
    };
  }

  function expectStack(overrides: Record<string, unknown> = {}) {
    const decoded = expectSuccess(decodePullRequestStacksJson(JSON.stringify([stack(overrides)])));
    if (decoded === null) throw new Error("expected a stack");
    return decoded;
  }

  it("reads the first stack, bottom to top, with merged_at outranking state", () => {
    expect(expectStack()).toEqual({
      id: "42",
      number: 3,
      url: "https://api.github.com/repos/acme/web/stacks/3",
      base: "main",
      layers: [
        { number: 10, headBranch: "feat/one", state: "merged" },
        { number: 11, headBranch: "feat/two", state: "open" },
        { number: 12, headBranch: "feat/three", state: "closed" },
      ],
    });
  });
});

const decodeWatchedResult = Schema.decodeUnknownSync(PullRequestWatchFingerprint.result);

const decodeWatched = (pullRequest: object) =>
  decodeWatchedResult({ repository: { pullRequest } }).repository!.pullRequest!;

describe("pull request lookups", () => {
  it("refuses what GitHub cannot name, so one bad row cannot fail a whole batch", () => {
    expect(pullRequestLookup({ repository: "acme/web", number: 7 })).toEqual({
      owner: "acme",
      name: "web",
      number: 7,
    });
    expect(pullRequestLookup({ repository: 'acme/web") { x } #', number: 1 })).toBeNull();
    expect(pullRequestLookup({ repository: "acme/web", number: 0 })).toBeNull();
    expect(pullRequestLookup({ repository: "acme/web", number: 1.5 })).toBeNull();
    expect(pullRequestLookup({ repository: "acme/web", number: 2 ** 31 })).toBeNull();
  });
});

describe("pull request watch fingerprints", () => {
  it("moves status with checks and remarks with comments, each without the other", () => {
    const pullRequest = (input: {
      readonly running: number;
      readonly failed: number;
      readonly commentEditedAt: string | null;
      readonly reviews: number;
    }) => ({
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: "abc123",
      comments: { totalCount: 1, nodes: [{ lastEditedAt: input.commentEditedAt }] },
      reviews: { totalCount: input.reviews, nodes: [] },
      reviewThreads: { totalCount: 0 },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  checkRunCountsByState: [
                    { state: "IN_PROGRESS", count: input.running },
                    { state: "FAILURE", count: input.failed },
                    { state: "SUCCESS", count: 0 },
                  ],
                  statusContextCountsByState: null,
                },
              },
            },
          },
        ],
      },
    });
    const fingerprint = (input: Parameters<typeof pullRequest>[0]) =>
      toPullRequestWatchFingerprint(decodeWatched(pullRequest(input)));
    const base = { running: 2, failed: 0, commentEditedAt: null, reviews: 1 };
    const before = fingerprint(base);
    const checkFinished = fingerprint({ ...base, running: 1, failed: 1 });
    const summaryEdited = fingerprint({ ...base, commentEditedAt: "2026-10-05T23:47:43Z" });
    const replied = fingerprint({ ...base, reviews: 2 });

    expect(checkFinished.status).not.toBe(before.status);
    expect(checkFinished.remarks).toBe(before.remarks);
    expect(summaryEdited.remarks).not.toBe(before.remarks);
    expect(summaryEdited.status).toBe(before.status);
    expect(replied.remarks).not.toBe(before.remarks);
  });
});
