import type { VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  aggregateRepoStatuses,
  isRepoPending,
  planSyncAll,
  summarizeRepoStatus,
} from "./MultiRepoGitControl.logic";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

function files(n: number): VcsStatusResult["workingTree"]["files"] {
  return Array.from({ length: n }, (_, i) => ({
    path: `file-${i}.ts`,
    insertions: 1,
    deletions: 0,
  }));
}

describe("isRepoPending", () => {
  it("is false for a clean, up-to-date repo", () => {
    assert.equal(isRepoPending(status()), false);
  });

  it("is true with working-tree changes, ahead, or behind", () => {
    assert.equal(isRepoPending(status({ hasWorkingTreeChanges: true })), true);
    assert.equal(isRepoPending(status({ aheadCount: 1 })), true);
    assert.equal(isRepoPending(status({ behindCount: 2 })), true);
  });

  it("is false for null status", () => {
    assert.equal(isRepoPending(null), false);
  });
});

describe("aggregateRepoStatuses", () => {
  it("sums changed files, ahead/behind, and counts pending repos", () => {
    const result = aggregateRepoStatuses([
      status({
        hasWorkingTreeChanges: true,
        workingTree: { files: files(3), insertions: 3, deletions: 0 },
      }),
      status({ aheadCount: 1 }),
      status({ behindCount: 2 }),
      status(),
      null,
    ]);
    assert.deepEqual(result, {
      repoCount: 5,
      pendingRepos: 3,
      changedFiles: 3,
      ahead: 1,
      behind: 2,
    });
  });

  it("reports all-clean with no pending repos", () => {
    const result = aggregateRepoStatuses([status(), status()]);
    assert.deepEqual(result, {
      repoCount: 2,
      pendingRepos: 0,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
    });
  });
});

describe("summarizeRepoStatus", () => {
  it("describes changes, ahead, and behind", () => {
    assert.equal(
      summarizeRepoStatus(
        status({
          hasWorkingTreeChanges: true,
          workingTree: { files: files(3), insertions: 3, deletions: 0 },
          aheadCount: 1,
          behindCount: 2,
        }),
        false,
      ),
      "3 changes · ↑1 · ↓2",
    );
  });

  it("singularizes a single change", () => {
    assert.equal(
      summarizeRepoStatus(
        status({
          hasWorkingTreeChanges: true,
          workingTree: { files: files(1), insertions: 1, deletions: 0 },
        }),
        false,
      ),
      "1 change",
    );
  });

  it("falls back to PR open then Clean", () => {
    assert.equal(
      summarizeRepoStatus(
        status({
          pr: {
            number: 1,
            title: "PR",
            url: "https://example.com/pr/1",
            baseRef: "main",
            headRef: "feature/test",
            state: "open",
          },
        }),
        false,
      ),
      "PR open",
    );
    assert.equal(summarizeRepoStatus(status(), false), "Clean");
  });

  it("shows a loading hint when status is not yet available", () => {
    assert.equal(summarizeRepoStatus(null, true), "Checking…");
    assert.equal(summarizeRepoStatus(null, false), "Unavailable");
  });
});

describe("planSyncAll", () => {
  function group(displayName: string, overrides: Partial<VcsStatusResult> = {}) {
    return { repoRoot: `/repos/${displayName}`, displayName, data: status(overrides) };
  }

  it("commits/pushes/pulls pending repos and omits clean ones", () => {
    const plan = planSyncAll([
      // Feature branch with changes → commit, push & PR.
      group("changes", { hasWorkingTreeChanges: true, hasUpstream: false }),
      // Behind upstream → pull.
      group("behind", { behindCount: 2 }),
      // Clean & up to date → omitted entirely.
      group("clean"),
    ]);
    assert.deepEqual(
      plan.steps.map((step) => ({ name: step.displayName, kind: step.kind })),
      [
        { name: "changes", kind: "run_action" },
        { name: "behind", kind: "pull" },
      ],
    );
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.defaultBranchRepos.length, 0);
  });

  it("flags repos that would push directly to their default branch", () => {
    const plan = planSyncAll([group("main", { hasWorkingTreeChanges: true, isDefaultRef: true })]);
    assert.equal(plan.steps.length, 1);
    assert.deepEqual(plan.defaultBranchRepos, ["main"]);
  });

  it("surfaces pending repos that can't auto-sync as skipped", () => {
    const plan = planSyncAll([
      // Diverged from upstream (ahead and behind) → needs a manual rebase/merge.
      group("diverged", { aheadCount: 1, behindCount: 2 }),
    ]);
    assert.equal(plan.steps.length, 0);
    assert.deepEqual(
      plan.skipped.map((skip) => skip.displayName),
      ["diverged"],
    );
  });
});
