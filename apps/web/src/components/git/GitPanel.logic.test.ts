import { assert, describe, it } from "vite-plus/test";

import type { VcsCommit, VcsWorkingTreeFile } from "@t3tools/contracts";
import {
  fileStatusLetter,
  mergeCommitPages,
  orderCommitRefNames,
  partitionWorkingTree,
  renameLabel,
  resolveCommitState,
  summarizeSection,
} from "./GitPanel.logic";

function makeFile(overrides: Partial<VcsWorkingTreeFile> & { path: string }): VcsWorkingTreeFile {
  return {
    insertions: 0,
    deletions: 0,
    indexStatus: null,
    worktreeStatus: null,
    ...overrides,
  };
}

function makeCommit(sha: string, overrides: Partial<VcsCommit> = {}): VcsCommit {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: `commit ${sha}`,
    authorName: "Ada",
    committedAt: "2026-08-01T10:00:00+00:00",
    refNames: [],
    isHead: false,
    ...overrides,
  };
}

describe("partitionWorkingTree", () => {
  it("splits staged from unstaged", () => {
    const sections = partitionWorkingTree([
      makeFile({ path: "staged.ts", indexStatus: "modified" }),
      makeFile({ path: "unstaged.ts", worktreeStatus: "modified" }),
      makeFile({ path: "new.ts", worktreeStatus: "untracked" }),
    ]);

    assert.deepStrictEqual(
      sections.staged.map((file) => file.path),
      ["staged.ts"],
    );
    assert.deepStrictEqual(
      sections.unstaged.map((file) => file.path),
      ["unstaged.ts", "new.ts"],
    );
    assert.strictEqual(sections.conflicted.length, 0);
  });

  it("puts a partially staged file in both sections", () => {
    const sections = partitionWorkingTree([
      makeFile({ path: "partial.ts", indexStatus: "modified", worktreeStatus: "modified" }),
    ]);

    assert.deepStrictEqual(
      sections.staged.map((file) => file.path),
      ["partial.ts"],
    );
    assert.deepStrictEqual(
      sections.unstaged.map((file) => file.path),
      ["partial.ts"],
    );
  });

  it("pulls conflicts out of both sections so they cannot be committed by accident", () => {
    const sections = partitionWorkingTree([
      makeFile({ path: "conflict.ts", indexStatus: "conflicted", worktreeStatus: "conflicted" }),
    ]);

    assert.strictEqual(sections.staged.length, 0);
    assert.strictEqual(sections.unstaged.length, 0);
    assert.deepStrictEqual(
      sections.conflicted.map((file) => file.path),
      ["conflict.ts"],
    );
  });
});

describe("resolveCommitState", () => {
  const empty = { staged: [], unstaged: [], conflicted: [] };

  it("enables the button only when something is staged", () => {
    assert.deepInclude(resolveCommitState({ sections: empty, isBusy: false, isRepo: true }), {
      disabled: true,
      disabledReason: "Stage a file to commit.",
    });
    assert.deepInclude(
      resolveCommitState({
        sections: { ...empty, staged: [makeFile({ path: "a.ts", indexStatus: "modified" })] },
        isBusy: false,
        isRepo: true,
      }),
      { label: "Commit Staged", disabled: false, disabledReason: null },
    );
  });

  it("blocks on conflicts even when something is staged", () => {
    const state = resolveCommitState({
      sections: {
        staged: [makeFile({ path: "a.ts", indexStatus: "modified" })],
        unstaged: [],
        conflicted: [makeFile({ path: "b.ts", indexStatus: "conflicted" })],
      },
      isBusy: false,
      isRepo: true,
    });

    assert.deepInclude(state, { disabled: true, disabledReason: "Resolve merge conflicts first." });
  });

  it("blocks while another git action runs, and outside a repository", () => {
    assert.deepInclude(resolveCommitState({ sections: empty, isBusy: true, isRepo: true }), {
      disabledReason: "Another Git action is running.",
    });
    assert.deepInclude(resolveCommitState({ sections: empty, isBusy: false, isRepo: false }), {
      disabledReason: "This folder is not a Git repository.",
    });
  });
});

describe("summarizeSection", () => {
  it("sums insertions and deletions", () => {
    assert.deepStrictEqual(
      summarizeSection([
        makeFile({ path: "a.ts", insertions: 3, deletions: 1 }),
        makeFile({ path: "b.ts", insertions: 4, deletions: 2 }),
      ]),
      { insertions: 7, deletions: 3 },
    );
  });
});

describe("fileStatusLetter", () => {
  it("reads the half of the code the section is showing", () => {
    const partial = makeFile({
      path: "a.ts",
      indexStatus: "added",
      worktreeStatus: "modified",
    });

    assert.strictEqual(fileStatusLetter(partial, "staged"), "A");
    assert.strictEqual(fileStatusLetter(partial, "unstaged"), "M");
  });
});

describe("renameLabel", () => {
  it("shows the move only for renames", () => {
    assert.strictEqual(
      renameLabel(makeFile({ path: "new.ts", originalPath: "old.ts", indexStatus: "renamed" })),
      "old.ts → new.ts",
    );
    assert.strictEqual(renameLabel(makeFile({ path: "a.ts", indexStatus: "modified" })), null);
  });
});

describe("orderCommitRefNames", () => {
  it("puts local branches first, then remotes, then tags", () => {
    assert.deepStrictEqual(orderCommitRefNames(["origin/main", "tag: v1.0.0", "main"]), [
      "main",
      "origin/main",
      "tag: v1.0.0",
    ]);
  });
});

describe("mergeCommitPages", () => {
  it("drops shas repeated across pages when history shifts mid-scroll", () => {
    const merged = mergeCommitPages([
      [makeCommit("aaa"), makeCommit("bbb")],
      [makeCommit("bbb"), makeCommit("ccc")],
    ]);

    assert.deepStrictEqual(
      merged.map((commit) => commit.sha),
      ["aaa", "bbb", "ccc"],
    );
  });
});
