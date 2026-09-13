import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  CommentsSchema,
  DiffSchema,
  PullDetailSchema,
  RawPullSchema,
  StackEnvelopeSchema,
  toActivity,
  toChangeRequest,
  toDiff,
  toStack,
} from "./gitCafePullRequestJson.ts";
const decodeRawPull = Schema.decodeUnknownSync(RawPullSchema);
const decodePullDetail = Schema.decodeUnknownSync(PullDetailSchema);
const decodeComments = Schema.decodeUnknownSync(CommentsSchema);
const decodeStackEnvelope = Schema.decodeUnknownSync(StackEnvelopeSchema);
const decodeDiff = Schema.decodeUnknownSync(DiffSchema);
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

describe("deployed GitCafe PR normalization", () => {
  it("keeps local and linked reviewer membership in all-feed rows", () => {
    const row = toChangeRequest(
      decodeRawPull({
        ...pull,
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
      "owner/repo",
    );
    expect(row.reviewRequestLogins).toEqual(["alice", "upstream", "linked-local"]);
  });
  it("reads flat summaries with separate draft state and absolute avatars", () => {
    expect(toChangeRequest(decodeRawPull(pull), "owner/repo")).toMatchObject({
      state: "open",
      isDraft: true,
      author: { login: "alice", name: null, avatarUrl: "https://git.cafe/avatars/one" },
      url: "https://git.cafe/owner/repo/pulls/7",
    });
  });
  it("distinguishes provider attribution from local handles", () => {
    const decoded = decodeRawPull({
      ...pull,
      author: { kind: "github", actorId: "act_remote", login: "remote-user", avatarUrl: null },
    });
    expect(toChangeRequest(decoded, "owner/repo").author?.login).toBe("remote-user");
  });
  it("requires deployed capabilities on detail responses", () => {
    expect(() => decodePullDetail(pull)).toThrow();
  });
  it("preserves persisted thread IDs across multiple comments", () => {
    const base = {
      author: actor,
      body: "Review",
      path: "file.ts",
      line: 3,
      side: "right",
      createdAt: timestamp,
      commitOid: "abcdef",
      resolvedAt: null,
    };
    const comments = decodeComments({
      items: [
        { ...base, id: "reply", threadId: "thread-one" },
        { ...base, id: "other", threadId: "thread-two" },
      ],
      nextAfter: "next",
    });
    const activity = toActivity(
      comments,
      { items: [], nextAfter: null },
      { items: [], headOid: "abcdef", truncated: false, nextAfter: null },
      "abcdef",
    );
    expect(activity.reviewThreads.map((thread) => thread.id)).toEqual(["thread-two", "thread-one"]);
    expect(activity.commentsTruncated).toBe(true);
  });
  it.each([timestamp, null])(
    "uses the root resolution when replies have no resolution: %s",
    (resolvedAt) => {
      const base = {
        author: actor,
        body: "Review",
        path: "file.ts",
        line: 3,
        side: "right",
        createdAt: timestamp,
        commitOid: "abcdef",
        threadId: "root",
      };
      const activity = toActivity(
        decodeComments({
          items: [
            { ...base, id: "root", resolvedAt },
            { ...base, id: "reply", resolvedAt: null },
          ],
          nextAfter: null,
        }),
        { items: [], nextAfter: null },
        { items: [], headOid: "abcdef", truncated: false, nextAfter: null },
        "abcdef",
      );
      expect(activity.reviewThreads).toHaveLength(1);
      expect(activity.reviewThreads[0]?.isResolved).toBe(resolvedAt !== null);
      expect(activity.reviewThreads[0]?.comments).toHaveLength(2);
    },
  );
  it("orders stack members and retains their independent draft flags", () => {
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
            position: 1,
          },
        ],
      },
    });
    expect(toStack(stack!, "owner/repo").layers).toMatchObject([
      { number: 6, state: "merged" },
      { number: 7, state: "open", isDraft: true },
    ]);
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
    expect(toDiff(diff).patch).toContain("@@ -1,1 +1,1 @@\n-old\n+new\n");
  });
  it("marks omitted patches incomplete even when the host's overall flag is false", () => {
    const diff = decodeDiff({
      items: [{ path: "large.ts", oldPath: null, status: "modified", tooLarge: true, hunks: [] }],
      truncated: false,
    });
    expect(toDiff(diff)).toMatchObject({
      truncated: true,
      omittedFileStats: [{ path: "large.ts", additions: 0, deletions: 0 }],
    });
  });
  it("preserves renamed and binary paths", () => {
    const diff = decodeDiff({
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
    });
    expect(toDiff(diff).patch).toContain('rename from "old image.png"');
    expect(toDiff(diff).patch).toContain(
      'Binary files "a/old image.png" and "b/new image.png" differ',
    );
  });
});
