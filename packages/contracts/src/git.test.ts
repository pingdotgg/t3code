import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  VcsCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  VcsStatusLocalResult,
} from "./git.ts";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeStatusLocalResult = Schema.decodeUnknownSync(VcsStatusLocalResult);

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

  it("accepts a thread id for VCS-neutral workspace creation", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      threadId: "thread-workspace",
      refName: "main",
      path: null,
    });

    expect(parsed.threadId).toBe("thread-workspace");
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

  it("decodes jj finalized and new workspace revisions", () => {
    const parsed = decodeRunStackedActionResult({
      action: "commit",
      branch: { status: "created", name: "feature/jj-change" },
      commit: {
        status: "created",
        commitSha: "finalized-commit",
        subject: "Finalize jj change",
        finalizedRevision: { commitId: "finalized-commit", changeId: "finalized-change" },
        workspaceRevision: { commitId: "workspace-commit", changeId: "workspace-change" },
        publishRef: {
          kind: "bookmark",
          name: "feature/jj-change",
          target: { commitId: "finalized-commit", changeId: "finalized-change" },
        },
      },
      push: { status: "skipped_not_requested" },
      pr: { status: "skipped_not_requested" },
      toast: { title: "Finalized finaliz", cta: { kind: "none" } },
    });

    expect(parsed.commit.workspaceRevision?.changeId).toBe("workspace-change");
    expect(parsed.commit.publishRef?.kind).toBe("bookmark");
  });
});

describe("VcsStatusLocalResult", () => {
  const baseStatus = {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  };

  it("requires variant-specific conflict details", () => {
    expect(
      decodeStatusLocalResult({
        ...baseStatus,
        conflicts: [
          { kind: "content", path: "conflicted.txt" },
          { kind: "named-ref", refName: "feature" },
        ],
      }).conflicts,
    ).toEqual([
      { kind: "content", path: "conflicted.txt" },
      { kind: "named-ref", refName: "feature" },
    ]);
    expect(() =>
      decodeStatusLocalResult({ ...baseStatus, conflicts: [{ kind: "content" }] }),
    ).toThrow();
    expect(() =>
      decodeStatusLocalResult({ ...baseStatus, conflicts: [{ kind: "named-ref" }] }),
    ).toThrow();
  });
});
