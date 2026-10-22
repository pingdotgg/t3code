import { PullRequestHostAction } from "./pullRequestHost.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PullRequestComment,
  PullRequestDetail,
  PullRequestListResult,
  pullRequestHostOf,
} from "./pullRequest.ts";

const decodeDetail = Schema.decodeUnknownSync(Schema.toCodecJson(PullRequestDetail));

it("carries reply targets through the comment wire codec and accepts older comments", () => {
  const original: PullRequestComment = {
    id: "17:1",
    kind: "issue-comment",
    author: null,
    body: "Question",
    createdAt: "2026-10-15T00:00:00Z",
    url: null,
    path: null,
    reviewState: null,
  };
  const codec = Schema.toCodecJson(PullRequestComment);
  const roundTrip = Schema.decodeSync(codec);
  const encode = Schema.encodeSync(codec);
  expect(roundTrip(encode(original))).toEqual(original);
  const reply = {
    ...original,
    id: "17:2",
    threadId: "17",
    replyToCommentId: original.id,
    body: "Answer",
  };
  expect(roundTrip(encode(reply))).toEqual(reply);
});

const LIST_RESULT: PullRequestListResult = {
  viewers: { "github.com": "bilal", "gitlab.com": "bilal.hassan" },
  providers: [
    {
      host: "github.com",
      kind: SourceControlProviderKind.make("github"),
      searchesOnHost: true,
      projectCount: 1,
      configured: true,
      detail: null,
    },
    {
      host: "gitlab.com",
      kind: SourceControlProviderKind.make("gitlab"),
      searchesOnHost: true,
      projectCount: 1,
      configured: false,
      detail: "glab is not installed.",
    },
  ],
  entries: [
    {
      provider: SourceControlProviderKind.make("github"),
      host: "github.com",
      projectId: "project-1" as PullRequestListResult["entries"][number]["projectId"],
      projectTitle: "t3code",
      repository: "pingdotgg/t3code",
      number: 1,
      title: "Add a pull requests page",
      url: "https://github.com/pingdotgg/t3code/pull/1",
      author: { login: "octocat", name: null, avatarUrl: null },
      headBranch: "feat/page",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 1,
      deletions: 0,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      viewerReviewRequested: false,
      labels: [{ name: "backend", color: null }],
    },
  ],
  errors: [],
  truncated: false,
  nextCursors: { "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|1|1" },
};

describe("PullRequestListResult", () => {
  it("separates Forgejo HTTP ports while preserving other provider host identities", () => {
    const identity = {
      canonicalKey: "forge.example/team/repo",
      locator: { remoteUrl: "http://forge.example:3000/team/repo.git" },
    };
    expect(pullRequestHostOf(identity, SourceControlProviderKind.make("forgejo"))).toBe(
      "forge.example:3000",
    );
    expect(pullRequestHostOf(identity, SourceControlProviderKind.make("gitlab"))).toBe(
      "forge.example",
    );
    expect(
      pullRequestHostOf(
        { ...identity, locator: { remoteUrl: "ssh://git@forge.example:2222/team/repo.git" } },
        SourceControlProviderKind.make("forgejo"),
      ),
    ).toBe("forge.example");
  });
  /**
   * The RPC builds this codec at call time, so a shape it cannot lower — an open-keyed record
   * with an optional value, for one — fails as an interrupted request rather than as a schema
   * error.
   */
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(PullRequestListResult);

    const decoded = Schema.decodeSync(codec)(Schema.encodeUnknownSync(codec)(LIST_RESULT));

    expect(decoded).toStrictEqual(LIST_RESULT);
  });
});

describe("PullRequestCapabilities", () => {
  const base = {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
    reviewers: { request: true, listCandidates: true },
  };

  it("loads a newer server's detail response, dropping unknown options in order", () => {
    const options = {
      actions: ["close", "archive", "merge"],
      verdicts: ["request-changes", "block", "approve"],
      updateMethods: ["rebase", "fast-forward", "merge"],
    };
    const detail = {
      ...LIST_RESULT.entries[0],
      workspaceRoot: "/workspace/t3code",
      body: "",
      changedFiles: 1,
      mergedAt: null,
      closedAt: null,
      reviewers: [],
      checks: [],
      mergeCapabilities: { merge: true, squash: true, rebase: true },
      capabilities: {
        ...base,
        actions: options.actions,
        mergeMethods: ["squash", "fast-forward", "merge"],
        updateMethods: options.updateMethods,
        review: { ...base.review, verdicts: options.verdicts },
      },
      viewerPermissions: { ...options, comment: true, resolve: true, requestReviewers: true },
    };
    const decoded = decodeDetail(detail);

    expect(decoded.capabilities).toEqual({
      ...base,
      actions: ["close", "merge"],
      mergeMethods: ["squash", "merge"],
      updateMethods: ["rebase", "merge"],
      review: { ...base.review, verdicts: ["request-changes", "approve"] },
    });
    expect(decoded.viewerPermissions).toEqual({
      actions: ["close", "merge"],
      verdicts: ["request-changes", "approve"],
      updateMethods: ["rebase", "merge"],
      comment: true,
      resolve: true,
      requestReviewers: true,
    });
    expect(decoded.title).toBe(detail.title);
  });
});

it("accepts native attachment names without allowing paths or control characters", () => {
  const decode = Schema.decodeUnknownSync(PullRequestHostAction);
  for (const fileName of ["test.txt", "réponse.txt", "test app.png"])
    expect(() => decode({ type: "attachment-upload", fileName, data: "VGVzdA==" })).not.toThrow();
  for (const fileName of [
    "../test.txt",
    "folder/test.txt",
    "folder" + String.fromCharCode(92) + "test.txt",
    "bad" + String.fromCharCode(0) + ".txt",
  ])
    expect(() => decode({ type: "attachment-delete", fileName })).toThrow();
});
