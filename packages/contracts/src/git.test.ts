import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  GitCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitResolvePullRequestResult,
  GitWorktreeBranchNaming,
} from "./git";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(GitCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeWorktreeBranchNaming = Schema.decodeUnknownSync(GitWorktreeBranchNaming);

describe("GitCreateWorktreeInput", () => {
  it("accepts omitted newBranch for existing-branch worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      branch: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newBranch).toBeUndefined();
    expect(parsed.branch).toBe("feature/existing");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
  });
});

describe("GitWorktreeBranchNaming", () => {
  it("decodes custom prefix mode", () => {
    const parsed = decodeWorktreeBranchNaming({
      mode: "prefix",
      prefix: "team-name",
    });

    expect(parsed).toEqual({
      mode: "prefix",
      prefix: "team-name",
    });
  });

  it("decodes full branch name mode", () => {
    const parsed = decodeWorktreeBranchNaming({
      mode: "full",
      branchName: "feature/custom-branch",
    });

    expect(parsed).toEqual({
      mode: "full",
      branchName: "feature/custom-branch",
    });
  });
});
