import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  VcsCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitActionProgressEvent,
  GitCommandError,
  GitResolvePullRequestResult,
} from "./git.ts";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeActionProgressEvent = Schema.decodeUnknownSync(GitActionProgressEvent);
const decodeGitCommandError = Schema.decodeUnknownSync(GitCommandError);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);

describe("VcsCreateWorktreeInput", () => {
  it("accepts omitted newRefName for existing-refName worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newRefName).toBeUndefined();
    expect(parsed.refName).toBe("feature/existing");
  });

  it("accepts baseRefName metadata for a new worktree ref", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "0123456789abcdef",
      newRefName: "feature/new",
      baseRefName: "origin/main",
      path: "/tmp/worktree",
    });

    expect(parsed.baseRefName).toBe("origin/main");
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

describe("GitRunStackedActionInput", () => {
  it("accepts explicit stacked actions and requires a client-provided actionId", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "create_pr",
    });

    expect(parsed.actionId).toBe("action-1");
    expect(parsed.action).toBe("create_pr");
    expect(parsed.disableCommitSigning).toBeUndefined();
  });

  it("accepts a per-attempt commit-signing override", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-2",
      cwd: "/repo",
      action: "commit",
      disableCommitSigning: true,
    });

    expect(parsed.disableCommitSigning).toBe(true);
  });
});

describe("GitActionProgressEvent", () => {
  it("defaults omitted failure classifications for older action-failure payloads", () => {
    const parsed = decodeActionProgressEvent({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "action_failed",
      phase: "commit",
      message: "Commit failed.",
    });

    expect(parsed).toMatchObject({
      kind: "action_failed",
      failureKind: "unknown",
    });
  });

  it("accepts action failures with an unknown classification", () => {
    const parsed = decodeActionProgressEvent({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "action_failed",
      phase: "commit",
      message: "Commit failed.",
      failureKind: "unknown",
    });

    expect(parsed.kind).toBe("action_failed");
    if (parsed.kind === "action_failed") {
      expect(parsed.failureKind).toBe("unknown");
    }
  });

  it("accepts classified commit-signing failures", () => {
    const parsed = decodeActionProgressEvent({
      actionId: "action-2",
      cwd: "/repo",
      action: "commit_push",
      kind: "action_failed",
      phase: "commit",
      message: "Commit failed.",
      failureKind: "commit_signing_failed",
    });

    expect(parsed).toMatchObject({
      kind: "action_failed",
      failureKind: "commit_signing_failed",
    });
  });
});

describe("GitCommandError", () => {
  const baseError = {
    _tag: "GitCommandError",
    operation: "GitVcsDriver.commit.commit",
    command: "git",
    cwd: "/repo",
    detail: "Git command exited with a non-zero status.",
  } as const;

  it("defaults omitted failure classifications for older command-error payloads", () => {
    expect(decodeGitCommandError(baseError).failureKind).toBe("unknown");
  });

  it("accepts errors with an unknown classification", () => {
    expect(
      decodeGitCommandError({
        ...baseError,
        failureKind: "unknown",
      }).failureKind,
    ).toBe("unknown");
  });

  it("accepts classified commit-signing errors", () => {
    expect(
      decodeGitCommandError({
        ...baseError,
        failureKind: "commit_signing_failed",
      }).failureKind,
    ).toBe("commit_signing_failed");
  });
});

describe("GitRunStackedActionResult", () => {
  it("decodes a server-authored completion toast", () => {
    const parsed = decodeRunStackedActionResult({
      action: "commit_push",
      branch: {
        status: "created",
        name: "feature/server-owned-toast",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: move toast state into git manager",
      },
      push: {
        status: "pushed",
        branch: "feature/server-owned-toast",
        upstreamBranch: "origin/feature/server-owned-toast",
      },
      pr: {
        status: "skipped_not_requested",
      },
      toast: {
        title: "Pushed 89abcde to origin/feature/server-owned-toast",
        description: "feat: move toast state into git manager",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      },
    });

    expect(parsed.toast.cta.kind).toBe("run_action");
    if (parsed.toast.cta.kind === "run_action") {
      expect(parsed.toast.cta.action.kind).toBe("create_pr");
    }
  });
});
