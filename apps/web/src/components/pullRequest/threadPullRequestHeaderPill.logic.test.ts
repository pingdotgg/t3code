import type { VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import { resolveThreadPullRequestHeaderPill } from "./threadPullRequestHeaderPill.logic";

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
    aheadOfDefaultCount: 1,
    pr: null,
    ...overrides,
  };
}

describe("when: the thread carries a pull request", () => {
  it("wears its number, whatever the ref is doing", () => {
    const pill = resolveThreadPullRequestHeaderPill({
      pullRequest: { number: 42, url: "https://example.com/pr/42" },
      gitStatus: status({ hasWorkingTreeChanges: true, behindCount: 3 }),
    });

    assert.deepEqual(pill, { kind: "linked", number: 42, url: "https://example.com/pr/42" });
  });

  it("wears its number even before git status arrives", () => {
    const pill = resolveThreadPullRequestHeaderPill({
      pullRequest: { number: 7, url: "https://example.com/pr/7" },
      gitStatus: null,
    });

    assert.deepEqual(pill, { kind: "linked", number: 7, url: "https://example.com/pr/7" });
  });
});

describe("when: the thread has no pull request", () => {
  it("offers to create one from a clean ref that is ahead of default", () => {
    assert.deepEqual(
      resolveThreadPullRequestHeaderPill({ pullRequest: null, gitStatus: status() }),
      {
        kind: "create",
      },
    );
  });

  it("offers to create one from an unpublished ref that has a remote to publish to", () => {
    const pill = resolveThreadPullRequestHeaderPill({
      pullRequest: null,
      gitStatus: status({ hasUpstream: false, aheadCount: 2, aheadOfDefaultCount: undefined }),
    });

    assert.deepEqual(pill, { kind: "create" });
  });

  it("falls back to the ahead count when the default branch delta is unknown", () => {
    const pill = resolveThreadPullRequestHeaderPill({
      pullRequest: null,
      gitStatus: status({ aheadCount: 0, aheadOfDefaultCount: undefined }),
    });

    assert.deepEqual(pill, { kind: "hidden" });
  });

  it("hides while git status is still loading", () => {
    assert.deepEqual(resolveThreadPullRequestHeaderPill({ pullRequest: null, gitStatus: null }), {
      kind: "hidden",
    });
  });

  it("hides on a detached head", () => {
    const pill = resolveThreadPullRequestHeaderPill({
      pullRequest: null,
      gitStatus: status({ refName: null }),
    });

    assert.deepEqual(pill, { kind: "hidden" });
  });

  it("hides with uncommitted work, because creating one would leave it behind", () => {
    const pill = resolveThreadPullRequestHeaderPill({
      pullRequest: null,
      gitStatus: status({ hasWorkingTreeChanges: true }),
    });

    assert.deepEqual(pill, { kind: "hidden" });
  });

  it("hides on a ref with nothing on top of the default branch", () => {
    const pill = resolveThreadPullRequestHeaderPill({
      pullRequest: null,
      gitStatus: status({ aheadOfDefaultCount: 0 }),
    });

    assert.deepEqual(pill, { kind: "hidden" });
  });

  it("hides while the ref is behind its upstream", () => {
    const pill = resolveThreadPullRequestHeaderPill({
      pullRequest: null,
      gitStatus: status({ behindCount: 1 }),
    });

    assert.deepEqual(pill, { kind: "hidden" });
  });

  it("hides when there is nowhere to push the ref", () => {
    const pill = resolveThreadPullRequestHeaderPill({
      pullRequest: null,
      gitStatus: status({ hasUpstream: false, hasPrimaryRemote: false }),
    });

    assert.deepEqual(pill, { kind: "hidden" });
  });

  it("hides when the ref already has an open pull request the thread has not linked", () => {
    const pill = resolveThreadPullRequestHeaderPill({
      pullRequest: null,
      gitStatus: status({
        pr: {
          number: 21,
          title: "Open PR",
          url: "https://example.com/pr/21",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
    });

    assert.deepEqual(pill, { kind: "hidden" });
  });

  it("offers to create one when the ref's last pull request is closed", () => {
    const pill = resolveThreadPullRequestHeaderPill({
      pullRequest: null,
      gitStatus: status({
        pr: {
          number: 20,
          title: "Closed PR",
          url: "https://example.com/pr/20",
          baseRef: "main",
          headRef: "feature/test",
          state: "closed",
        },
      }),
    });

    assert.deepEqual(pill, { kind: "create" });
  });
});
