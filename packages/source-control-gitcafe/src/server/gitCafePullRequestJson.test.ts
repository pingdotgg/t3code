import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as GitCafePullRequestJson from "./gitCafePullRequestJson.ts";

const decodePull = Schema.decodeUnknownSync(GitCafePullRequestJson.GitCafePull);
const decodePullDetail = Schema.decodeUnknownSync(GitCafePullRequestJson.GitCafePullDetail);
const decodeComments = Schema.decodeUnknownSync(GitCafePullRequestJson.GitCafeComments);
const decodeReviews = Schema.decodeUnknownSync(GitCafePullRequestJson.GitCafeReviews);
const decodeCommits = Schema.decodeUnknownSync(GitCafePullRequestJson.GitCafeCommits);
const decodeReactions = Schema.decodeUnknownSync(GitCafePullRequestJson.GitCafeReactions);
const decodeStackEnvelope = Schema.decodeUnknownSync(GitCafePullRequestJson.GitCafeStackEnvelope);
const decodeDiff = Schema.decodeUnknownSync(GitCafePullRequestJson.GitCafeDiff);
const decodeChecks = Schema.decodeUnknownSync(GitCafePullRequestJson.GitCafeChecks);

const timestamp = "2026-09-12T12:00:00Z";
const actor = {
  kind: "local",
  actorId: "act_one",
  handle: "alice",
  displayName: null,
  avatarUrl: "/avatars/one",
};
const pull = {
  id: "pr_one",
  number: 7,
  title: "Change",
  state: "open",
  draft: true,
  sourceBranch: "feature",
  targetBranch: "main",
  headOid: "abcdef",
  author: actor,
  createdAt: timestamp,
  updatedAt: timestamp,
  version: 1,
};
const detail = {
  ...pull,
  draft: false,
  description: "Body",
  closedAt: null,
  mergedAt: null,
  sourceRepo: null,
  capabilities: { comment: true, review: true, merge: true, edit: true, moderate: true },
};
const lineComment = {
  author: actor,
  body: "Review",
  path: "file.ts",
  line: 3,
  side: "right",
  createdAt: timestamp,
  commitOid: "abcdef",
  resolvedAt: null,
};
const capabilities = (overrides: Record<string, boolean> = {}) => ({
  edit: false,
  hide: false,
  unhide: false,
  delete: false,
  resolve: false,
  unresolve: false,
  ...overrides,
});
const noReviews = decodeReviews({ items: [], next: null });
const noCommits = decodeCommits({ items: [], headOid: "abcdef", truncated: false, next: null });
const activity = (
  comments: ReadonlyArray<Record<string, unknown>>,
  extra: { readonly reactions?: unknown; readonly host?: string } = {},
) =>
  GitCafePullRequestJson.toActivity({
    comments: decodeComments({ items: comments, next: null }),
    reviews: noReviews,
    commits: noCommits,
    headOid: "abcdef",
    host: extra.host ?? "git.cafe",
    ...(extra.reactions === undefined ? {} : { reactions: decodeReactions(extra.reactions) }),
  });

describe("toChangeRequest", () => {
  it("reads draft state, the repository host's URLs and absolute avatars", () => {
    const row = GitCafePullRequestJson.toChangeRequest(decodePull(pull), {
      repository: "owner/repo",
      host: "staging.git.cafe",
    });
    assert.strictEqual(row.state, "open");
    assert.isTrue(row.isDraft);
    assert.strictEqual(row.url, "https://staging.git.cafe/owner/repo/pulls/7");
    assert.deepStrictEqual(row.author, {
      login: "alice",
      name: null,
      avatarUrl: "https://staging.git.cafe/avatars/one",
    });
  });

  it("names linked GitHub reviewers by both logins and drops unavailable ones", () => {
    const row = GitCafePullRequestJson.toChangeRequest(
      decodePull({
        ...pull,
        author: { kind: "github", actorId: "act_remote", login: "remote-user", avatarUrl: null },
        reviewers: [
          { actor },
          {
            actor: {
              kind: "github",
              actorId: "act_github",
              login: "upstream",
              avatarUrl: null,
              linkedProfile: { handle: "linked-local" },
            },
          },
          { actor: { kind: "unavailable", actorId: "act_deleted" } },
        ],
      }),
      { repository: "owner/repo", host: "git.cafe" },
    );
    assert.strictEqual(row.author?.login, "remote-user");
    assert.deepStrictEqual(row.reviewRequestLogins, ["alice", "upstream", "linked-local"]);
  });

  it("marks a mirrored GitHub bot account as a bot", () => {
    const row = (accountType: string) =>
      GitCafePullRequestJson.toChangeRequest(
        decodePull({
          ...pull,
          author: {
            kind: "github",
            actorId: "act_bot",
            login: "coderabbitai[bot]",
            accountType,
            avatarUrl: null,
          },
        }),
        { repository: "owner/repo", host: "git.cafe" },
      );
    assert.isTrue(row("bot").author?.isBot);
    assert.isUndefined(row("user").author?.isBot);
  });
});

describe("toViewerPermissions", () => {
  const permissions = (overrides: Record<string, unknown>) =>
    GitCafePullRequestJson.toViewerPermissions(decodePullDetail({ ...detail, ...overrides }));

  it("keeps a locked conversation's composer for moderators only", () => {
    const locked = (moderate: boolean) =>
      permissions({
        lockedAt: timestamp,
        capabilities: { comment: true, review: false, merge: false, edit: false, moderate },
      });
    assert.isFalse(locked(false).comment);
    assert.isFalse(locked(false).resolve);
    assert.isTrue(locked(true).comment);
    assert.deepStrictEqual(locked(true).verdicts, []);
  });
});

describe("toActivity", () => {
  it("groups line comments by their persisted thread id and marks a paged list truncated", () => {
    const result = GitCafePullRequestJson.toActivity({
      comments: decodeComments({
        items: [
          { ...lineComment, id: "reply", threadId: "thread-one" },
          { ...lineComment, id: "other", threadId: "thread-two" },
        ],
        next: "next",
      }),
      reviews: noReviews,
      commits: noCommits,
      headOid: "abcdef",
      host: "git.cafe",
    });
    assert.deepStrictEqual(result.reviewThreads.map((thread) => thread.id).toSorted(), [
      "thread-one",
      "thread-two",
    ]);
    assert.isTrue(result.commentsTruncated);
  });

  it.each([timestamp, null])("takes the thread's resolution from its root: %s", (resolvedAt) => {
    const result = activity([
      { ...lineComment, id: "root", threadId: "root", resolvedAt },
      { ...lineComment, id: "reply", threadId: "root", resolvedAt: null },
    ]);
    assert.strictEqual(result.reviewThreads.length, 1);
    assert.strictEqual(result.reviewThreads[0]?.isResolved, resolvedAt !== null);
    assert.strictEqual(result.reviewThreads[0]?.comments.length, 2);
  });

  it("carries per-remark edit permission onto both copies of a remark", () => {
    const result = activity([
      {
        ...lineComment,
        id: "root",
        threadId: "root",
        capabilities: capabilities({ edit: false, resolve: true }),
      },
      {
        ...lineComment,
        id: "reply",
        threadId: "root",
        capabilities: capabilities({ edit: true }),
      },
      { ...lineComment, id: "silent", threadId: "silent", path: null, line: null, side: null },
    ]);
    const canEdit = (id: string) => result.comments.find((comment) => comment.id === id)?.canEdit;
    assert.strictEqual(canEdit("root"), false);
    assert.strictEqual(canEdit("reply"), true);
    assert.isUndefined(canEdit("silent"));
    assert.deepStrictEqual(
      result.reviewThreads[0]?.comments.map((comment) => [comment.id, comment.canEdit]),
      [
        ["root", false],
        ["reply", true],
      ],
    );
  });

  it("maps supported reactions to the pull request and to matching comments in both views", () => {
    const result = activity(
      [
        { ...lineComment, id: "comment-a", threadId: "comment-a" },
        { ...lineComment, id: "comment-b", threadId: "comment-a" },
      ],
      {
        reactions: {
          next: null,
          items: [
            {
              subject: { kind: "pull_request_comment", id: "comment-b" },
              emoji: { kind: "unicode", value: "👍" },
              count: 3,
              viewerReactionId: "reaction-viewer",
              reactors: [actor, { kind: "unavailable", actorId: "deleted" }],
            },
            {
              subject: { kind: "pull_request", id: "pr_one" },
              emoji: { kind: "unicode", value: "🚀" },
              count: 1,
              viewerReactionId: null,
              reactors: [actor],
            },
            {
              subject: { kind: "pull_request", id: "pr_one" },
              emoji: { kind: "custom", id: "party-parrot" },
              count: 2,
              viewerReactionId: null,
              reactors: [actor],
            },
            {
              subject: { kind: "pull_request", id: "pr_one" },
              emoji: { kind: "unicode", value: "🔥" },
              count: 1,
              viewerReactionId: null,
              reactors: [actor],
            },
          ],
        },
      },
    );
    const thumbsUp = {
      content: "thumbs-up",
      count: 3,
      actors: ["alice"],
      viewerHasReacted: true,
    } as const;
    assert.deepStrictEqual(result.reactions, [
      { content: "rocket", count: 1, actors: ["alice"], viewerHasReacted: false },
    ]);
    assert.deepStrictEqual(
      result.comments.map((comment) => [comment.id, comment.reactions]),
      [
        ["comment-a", []],
        ["comment-b", [thumbsUp]],
      ],
    );
    assert.deepStrictEqual(
      result.reviewThreads[0]?.comments.map((comment) => [comment.id, comment.reactions]),
      [
        ["comment-a", []],
        ["comment-b", [thumbsUp]],
      ],
    );
  });
});

describe("toStack", () => {
  it("orders members by position and reports heads only where GitCafe gives them", () => {
    const { stack } = decodeStackEnvelope({
      stack: {
        id: "stack-one",
        number: 3,
        revision: 1,
        landingBase: "main",
        members: [
          {
            pullRequestNumber: 7,
            title: "Top",
            state: "open",
            draft: true,
            sourceBranch: "feature",
            position: 2,
          },
          {
            pullRequestNumber: 6,
            title: "Base",
            state: "merged",
            draft: false,
            sourceBranch: "base",
            headOid: "0123456789abcdef0123456789abcdef01234567",
            position: 1,
          },
        ],
      },
    });
    assert.isNotNull(stack);
    const result = GitCafePullRequestJson.toStack(stack!, {
      repository: "owner/repo",
      host: "staging.git.cafe",
    });
    assert.strictEqual(result.url, "https://staging.git.cafe/owner/repo/stacks/3");
    assert.strictEqual(result.base, "main");
    assert.deepStrictEqual(result.layers, [
      {
        number: 6,
        title: "Base",
        headBranch: "base",
        state: "merged",
        isDraft: false,
        headSha: "0123456789abcdef0123456789abcdef01234567",
      },
      { number: 7, title: "Top", headBranch: "feature", state: "open", isDraft: true },
    ]);
  });
});

describe("toDiff", () => {
  it("marks the unterminated 93-byte tunnel-release migration as missing its final newline", () => {
    const content =
      'ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "tunnel_released_at" varchar(64);';
    assert.strictEqual(Buffer.byteLength(content), 93);
    const { patch } = GitCafePullRequestJson.toDiff(
      decodeDiff({
        items: [
          {
            path: "infra/relay/migrations/postgres/20261005232034_managed_endpoint_tunnel_released_at/migration.sql",
            status: "added",
            hunks: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                lines: [{ origin: "+", content }],
              },
            ],
          },
        ],
      }),
    );
    assert.isTrue(patch.endsWith(`+${content}\n\\ No newline at end of file\n`));
  });

  it.each(["+", "-", " "])("marks unterminated ordinary %j lines", (origin) => {
    const { patch } = GitCafePullRequestJson.toDiff(
      decodeDiff({
        items: [
          {
            path: "file.ts",
            status: "modified",
            hunks: [
              {
                oldStart: 1,
                oldLines: origin === "+" ? 0 : 1,
                newStart: 1,
                newLines: origin === "-" ? 0 : 1,
                lines: [{ origin, content: "value" }],
              },
            ],
          },
        ],
      }),
    );
    assert.isTrue(patch.endsWith(`${origin}value\n\\ No newline at end of file\n`));
  });

  it.each([
    ["+", ">"],
    ["-", "<"],
    [" ", "="],
  ])("emits one marker for an explicit %s/%s EOF pair", (origin, marker) => {
    const { patch } = GitCafePullRequestJson.toDiff(
      decodeDiff({
        items: [
          {
            path: "file.ts",
            status: "modified",
            hunks: [
              {
                oldStart: 1,
                oldLines: origin === "+" ? 0 : 1,
                newStart: 1,
                newLines: origin === "-" ? 0 : 1,
                lines: [
                  { origin, content: "value" },
                  { origin: marker, content: "\n" },
                ],
              },
            ],
          },
        ],
      }),
    );
    assert.strictEqual(patch.split("\\ No newline at end of file").length - 1, 1);
  });

  it.each([false, true])("preserves rename metadata for changed=%s", (changed) => {
    const { patch } = GitCafePullRequestJson.toDiff(
      decodeDiff({
        items: [
          {
            path: "after.ts",
            oldPath: "before.ts",
            status: "renamed",
            hunks: changed
              ? [
                  {
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 1,
                    lines: [
                      { origin: "-", content: "before\n" },
                      { origin: "+", content: "after\n" },
                    ],
                  },
                ]
              : [],
          },
        ],
      }),
    );
    assert.include(patch, changed ? "similarity index 0%\n" : "similarity index 100%\n");
    assert.include(patch, "rename from before.ts\nrename to after.ts\n");
  });

  it("converts numeric hunk coordinates into a unified patch", () => {
    const diff = decodeDiff({
      items: [
        {
          path: "file.ts",
          oldPath: null,
          status: "modified",
          additions: 1,
          deletions: 1,
          binary: false,
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                { origin: "-", content: "old\n" },
                { origin: "+", content: "new\n" },
              ],
            },
          ],
        },
      ],
      truncated: false,
    });
    assert.include(GitCafePullRequestJson.toDiff(diff).patch, "@@ -1,1 +1,1 @@\n-old\n+new\n");
  });

  it("marks an omitted patch incomplete even when GitCafe's own flag is false", () => {
    const diff = decodeDiff({
      items: [{ path: "large.ts", oldPath: null, status: "modified", tooLarge: true, hunks: [] }],
      truncated: false,
    });
    const result = GitCafePullRequestJson.toDiff(diff);
    assert.isTrue(result.truncated);
    assert.deepStrictEqual(result.omittedFileStats, [
      { path: "large.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("quotes renamed and binary paths", () => {
    const { patch } = GitCafePullRequestJson.toDiff(
      decodeDiff({
        items: [
          {
            path: "new image.png",
            oldPath: "old image.png",
            status: "renamed",
            binary: true,
            hunks: [],
          },
        ],
        truncated: false,
      }),
    );
    assert.include(patch, "rename from old image.png");
    assert.include(patch, "Binary files a/old image.png and b/new image.png differ");
  });

  it("C-escapes a name whose newline or tab would break the patch headers", () => {
    const { patch } = GitCafePullRequestJson.toDiff(
      decodeDiff({
        items: [{ path: "two\nlines\tname.ts", status: "added", hunks: [] }],
        truncated: false,
      }),
    );
    assert.include(patch, 'diff --git "a/two\\nlines\\tname.ts" "b/two\\nlines\\tname.ts"');
    assert.notInclude(patch, "two\nlines");
  });
});

describe("toChecks", () => {
  it("maps GitCafe's status and conclusion onto the shared check states", () => {
    const check = (
      status: string,
      conclusion: string | null,
      name = `${status}-${conclusion}`,
    ) => ({
      name,
      status,
      conclusion,
      summary: null,
      detailsUrl: null,
    });
    const checks = GitCafePullRequestJson.toChecks(
      decodeChecks({
        items: [
          check("queued", null),
          check("in_progress", null),
          check("completed", "success", "Build"),
          check("completed", "cancelled"),
          check("completed", "action_required"),
          check("completed", "timed_out", "Lint"),
        ],
        next: null,
      }),
    );
    assert.deepStrictEqual(
      checks.map((item) => [item.name, item.status]),
      [
        ["completed-cancelled", "cancelled"],
        ["Lint", "failure"],
        ["queued-null", "pending"],
        ["in_progress-null", "pending"],
        ["Build", "success"],
        ["completed-action_required", "action-required"],
      ],
    );
  });

  it("keeps only the newest run of a re-run check", () => {
    const run = (id: string, conclusion: string, githubApp = "github-actions") => ({
      id,
      provider: "github",
      githubApp,
      name: "Check",
      status: "completed",
      conclusion,
      summary: null,
      detailsUrl: null,
    });
    const statusOf = (items: ReadonlyArray<ReturnType<typeof run>>) =>
      GitCafePullRequestJson.toChecks(decodeChecks({ items, next: null })).map(
        (check) => check.status,
      );
    assert.deepStrictEqual(statusOf([run("99", "failure"), run("100", "success")]), ["success"]);
    assert.deepStrictEqual(statusOf([run("101", "failure"), run("100", "success")]), ["failure"]);
    // Another app's run of the same name is a separate check, not a re-run.
    assert.deepStrictEqual(statusOf([run("100", "failure", "a"), run("101", "success", "b")]), [
      "failure",
      "success",
    ]);
    // Commit statuses carry no run order, so neither is taken for the other's re-run.
    assert.deepStrictEqual(statusOf([run("status:2", "failure"), run("status:1", "success")]), [
      "failure",
      "success",
    ]);
  });
});
