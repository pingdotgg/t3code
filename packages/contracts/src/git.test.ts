import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
  VcsCreateWorktreeInput,
} from "./git.ts";
import { PullRequestDiffFileContentsInput } from "./pullRequest.ts";
import { ReviewDiffFileContentsInput } from "./review.ts";

const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const encodeRunStackedActionInput = Schema.encodeUnknownSync(GitRunStackedActionInput);
const decodeReviewDiffFileContentsInput = Schema.decodeUnknownSync(ReviewDiffFileContentsInput);
const encodeReviewDiffFileContentsInput = Schema.encodeUnknownSync(ReviewDiffFileContentsInput);
const decodePullRequestDiffFileContentsInput = Schema.decodeUnknownSync(
  PullRequestDiffFileContentsInput,
);
const encodePullRequestDiffFileContentsInput = Schema.encodeUnknownSync(
  PullRequestDiffFileContentsInput,
);

describe("GitCommandError", () => {
  it("decodes an unknown failure reason as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.message).toBe(
      "Git command failed in GitVcsDriver.createWorktree (/repo): git worktree add failed",
    );
  });
});

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });
});

describe("Git file paths", () => {
  it.each([
    {
      operation: "commit",
      decode: decodeRunStackedActionInput,
      encode: encodeRunStackedActionInput,
      input: {
        actionId: "action-1",
        cwd: "/repo",
        action: "commit",
        filePaths: [" leading.txt", "trailing.txt "],
      },
    },
    {
      operation: "local diff expansion",
      decode: decodeReviewDiffFileContentsInput,
      encode: encodeReviewDiffFileContentsInput,
      input: {
        cwd: "/repo",
        sourceKind: "working-tree",
        changeType: "rename-changed",
        baseRef: "HEAD",
        headRef: null,
        oldPath: " leading.txt",
        newPath: "trailing.txt ",
      },
    },
    {
      operation: "pull request diff expansion",
      decode: decodePullRequestDiffFileContentsInput,
      encode: encodePullRequestDiffFileContentsInput,
      input: {
        projectId: "project-1",
        repository: "owner/repo",
        number: 1,
        changeType: "rename-changed",
        oldPath: " leading.txt",
        newPath: "trailing.txt ",
      },
    },
  ])("preserves leading and trailing whitespace for $operation", ({ decode, encode, input }) => {
    expect(decode(input)).toEqual(input);
    expect(encode(input)).toEqual(input);
  });
});

describe("Git ref names", () => {
  it("keep non-ASCII whitespace across RPC and still trim ASCII whitespace", () => {
    const decode = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
    const encode = Schema.encodeUnknownSync(VcsCreateWorktreeInput);
    for (const branch of ["feature/memo\u3000", "feature/memo\u00a0", "\u3000"]) {
      const input = { cwd: "/repo", refName: `origin/${branch}`, baseRefName: branch, path: null };
      expect(decode(input)).toEqual(input);
      expect(encode(input)).toEqual(input);
    }
    expect(
      decode({ cwd: "/repo", refName: " origin/feature\n", baseRefName: "\tmain ", path: null }),
    ).toEqual({ cwd: "/repo", refName: "origin/feature", baseRefName: "main", path: null });
    expect(() => decode({ cwd: "/repo", refName: " \n", path: null })).toThrow();
  });
});
