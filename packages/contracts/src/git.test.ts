import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
  VcsCreateWorktreeInput,
  VcsRef,
} from "./git.ts";
import { WorktreeMcpHandoffInput } from "./worktreeMcp.ts";
import { PullRequestDiffFileContentsInput } from "./pullRequest.ts";
import { ReviewDiffFileContentsInput } from "./review.ts";

const encodeVcsRef = Schema.encodeUnknownSync(VcsRef);
const decodeVcsRef = Schema.decodeUnknownSync(VcsRef);
const encodeCreateWorktreeInput = Schema.encodeUnknownSync(VcsCreateWorktreeInput);
const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodeWorktreeHandoffInput = Schema.decodeUnknownSync(WorktreeMcpHandoffInput);
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
  it.each(["origin/release/v2\u3000", "\u00a0release", "\u3000"])(
    "keeps Unicode whitespace at the edges of %j across the wire",
    (name) => {
      const ref = { name, upstreamRef: `refs/remotes/${name}`, current: false, isDefault: false };
      const wireRef = encodeVcsRef({ ...ref, worktreePath: null });
      expect(decodeVcsRef(wireRef)).toMatchObject(ref);

      const input = { cwd: "/repo", refName: name, newRefName: name, baseRefName: name };
      const wireInput = encodeCreateWorktreeInput({ ...input, path: null });
      expect(decodeCreateWorktreeInput(wireInput)).toMatchObject(input);

      const handoff = { branch: name, baseRef: name, startFromOrigin: true };
      expect(decodeWorktreeHandoffInput(handoff)).toEqual(handoff);
    },
  );

  it("still trims ASCII whitespace and rejects a blank name", () => {
    expect(
      decodeCreateWorktreeInput({ cwd: "/repo", refName: " \tmain\n", path: null }).refName,
    ).toBe("main");
    expect(() => decodeCreateWorktreeInput({ cwd: "/repo", refName: " \t", path: null })).toThrow();
  });
});
