import { describe, expect, it } from "vite-plus/test";
import {
  branchDeletedToastText,
  commitToastText,
  confirmAbortOperation,
  confirmDeleteBranch,
  confirmDirtyCheckout,
  confirmDiscardHunk,
  confirmDiscardIrrecoverable,
  confirmMergeBranch,
  confirmResetHard,
  confirmRevertMerge,
  confirmStashDrop,
  discardRequiresConfirm,
  discardToastText,
  noteDiscardRecoverability,
  undoCommitToastText,
  EMPTY_DISCARD_RECOVERABILITY,
} from "./safetyLadder";

/**
 * One test per rung of the safety ladder.
 *
 * The point of pinning these is not the wording — it is the GRADE. Each
 * assertion encodes a decision that was made once and is easy to undo by
 * accident: that reset --hard is the only action severe enough for
 * `requireTyped`, that a dirty checkout must offer stashing as a peer rather
 * than making you cancel and go stash by hand, that deleting an unmerged branch
 * has to name what is at risk, and that `consequence` is never allowed to be a
 * bare "are you sure?".
 */

describe("every dialog says what is lost", () => {
  const all = [
    confirmDeleteBranch("feat", { unmerged: false }),
    confirmDeleteBranch("feat", { unmerged: true, lostCommits: ["a1b2c3d wip"] }),
    confirmStashDrop({ ref: "stash@{0}", message: "wip" }),
    confirmAbortOperation("merge"),
    confirmMergeBranch("feat", "main"),
    confirmDiscardHunk("src/a.ts"),
    confirmDiscardIrrecoverable(["src/a.ts"]),
    confirmDirtyCheckout("feat", 3),
    confirmResetHard("a1b2c3d4", true),
    confirmRevertMerge("a1b2c3d4"),
  ];

  it('carries a non-trivial consequence, never a bare "are you sure?"', () => {
    for (const options of all) {
      expect(options.consequence.length).toBeGreaterThan(24);
      expect(options.consequence.toLowerCase()).not.toContain("are you sure");
    }
  });

  it('labels the confirm button with the verb, not "OK"', () => {
    for (const options of all) {
      expect(options.confirmLabel).toBeTruthy();
      expect(["OK", "Yes", "Confirm"]).not.toContain(options.confirmLabel);
    }
  });

  it("always states a tone, so nothing renders neutral by omission", () => {
    for (const options of all) {
      expect(["danger", "neutral"]).toContain(options.tone);
    }
  });
});

describe("reset --hard is the ONLY requireTyped", () => {
  it('requires typing "reset"', () => {
    expect(confirmResetHard("a1b2c3d4", true).requireTyped).toBe("reset");
  });

  it("names the working tree only when there is one to lose", () => {
    expect(confirmResetHard("a1b2c3d4", true).consequence).toContain("uncommitted");
    expect(confirmResetHard("a1b2c3d4", false).consequence).not.toContain("uncommitted");
  });

  it("shortens the hash for the title", () => {
    expect(confirmResetHard("a1b2c3d4e5f6", false).title).toContain("a1b2c3d");
  });

  it("nothing else asks the user to type a word — that is theatre below the top rung", () => {
    const others = [
      confirmDeleteBranch("feat", { unmerged: true }),
      confirmStashDrop({ ref: "stash@{0}" }),
      confirmAbortOperation("rebase"),
      confirmDirtyCheckout("feat", 1),
      confirmDiscardIrrecoverable(null),
      confirmDiscardHunk("a.ts"),
      confirmMergeBranch("feat", "main"),
      confirmRevertMerge("abc1234"),
    ];
    for (const options of others) {
      expect(options.requireTyped).toBeUndefined();
    }
  });
});

describe("delete branch — graded by whether commits are actually at risk", () => {
  it("merged: lightweight, says nothing is lost, and confirms only once", () => {
    const options = confirmDeleteBranch("feat", { unmerged: false });
    expect(options.consequence).toContain("nothing is lost");
    expect(options.body).toBeUndefined();
    expect(options.repeatConfirm).toBeUndefined();
  });

  it("unmerged: names the count, lists the commits, and confirms twice", () => {
    const options = confirmDeleteBranch("feat", {
      unmerged: true,
      lostCommits: ["a1b2c3d wip", "e4f5a6b more wip"],
    });
    expect(options.consequence).toContain("2 commits");
    expect(options.body).toContain("a1b2c3d wip");
    expect(options.body).toContain("e4f5a6b more wip");
    expect(options.repeatConfirm).toBe(true);
  });

  it("unmerged with no commit list still warns rather than going quiet", () => {
    expect(confirmDeleteBranch("feat", { unmerged: true }).consequence).toContain(
      "not fully merged",
    );
  });

  it("reads a single lost commit in the singular", () => {
    expect(
      confirmDeleteBranch("feat", { unmerged: true, lostCommits: ["a1 wip"] }).consequence,
    ).toContain("1 commit on");
  });

  it("the toast prints the SHA — that is what makes it recoverable", () => {
    expect(branchDeletedToastText("feat", "a1b2c3d4e5")).toContain("git checkout a1b2c3d");
  });

  it("…and says nothing about recovery when there is no SHA to give", () => {
    expect(branchDeletedToastText("feat")).not.toContain("git checkout");
  });
});

describe("stash drop — the action with no undo at all", () => {
  it("states plainly that there is no undo", () => {
    const options = confirmStashDrop({ ref: "stash@{0}", message: "wip: parser" });
    expect(options.consequence).toContain("no undo");
    expect(options.tone).toBe("danger");
  });

  it("identifies WHICH stash, by message when there is one", () => {
    expect(confirmStashDrop({ ref: "stash@{2}", message: "wip: parser" }).body).toBe("wip: parser");
    expect(confirmStashDrop({ ref: "stash@{2}", message: "  " }).body).toBe("stash@{2}");
    expect(confirmStashDrop({}).body).toBe("this stash");
  });
});

describe("dirty checkout — offers the safer path as a peer", () => {
  it('offers "Stash and switch" alongside the destructive answer', () => {
    expect(confirmDirtyCheckout("feat", 3).alternative).toEqual({ label: "Stash and switch" });
  });

  it("says how many files are at stake, in the right number", () => {
    expect(confirmDirtyCheckout("feat", 3).consequence).toContain("3 changed files");
    expect(confirmDirtyCheckout("feat", 1).consequence).toContain("1 changed file will");
  });
});

describe("discard — the ladder inverts, because it is undoable", () => {
  it("the irrecoverable dialog is reachable ONLY as the old-git fallback, and says why", () => {
    const options = confirmDiscardIrrecoverable(["a.ts", "b.ts"]);
    expect(options.consequence).toContain("too old to keep a backup");
    expect(options.consequence).toContain("2 files");
    expect(options.body).toContain("a.ts");
  });

  it("scopes the whole-tree case as such", () => {
    expect(confirmDiscardIrrecoverable(null).consequence).toContain("every uncommitted change");
    expect(confirmDiscardIrrecoverable(null).body).toBeUndefined();
  });

  it("truncates a long file list rather than rendering 200 rows", () => {
    const files = Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts`);
    const body = confirmDiscardIrrecoverable(files).body ?? "";
    expect(body).toContain("…and 22 more");
    expect(body.split("\n")).toHaveLength(9);
  });

  it("hunk discard keeps its confirm, and explains that it is the exception", () => {
    const options = confirmDiscardHunk("src/a.ts");
    expect(options.consequence).toContain("not undoable");
    expect(options.body).toBe("src/a.ts");
  });

  it("the undo toast names the scope it can restore", () => {
    expect(discardToastText(null)).toBe("Discarded all changes");
    expect(discardToastText(["src/a.ts"])).toBe("Discarded changes in src/a.ts");
    expect(discardToastText(["a", "b", "c"])).toBe("Discarded changes in 3 files");
  });
});

describe("toasts that replace a dialog when the action is undoable", () => {
  it("commit reports the sha and the file count", () => {
    expect(commitToastText("a1b2c3d", 4)).toBe("Committed a1b2c3d — 4 files");
    expect(commitToastText("a1b2c3d", 1)).toBe("Committed a1b2c3d — 1 file");
  });

  it("undo-last-commit says where the work went, since it is not obvious", () => {
    expect(undoCommitToastText()).toContain("kept staged");
  });
});

describe("abort / merge — neutral where the action is reversible", () => {
  it("abort names the operation in both title and consequence", () => {
    const options = confirmAbortOperation("rebase");
    expect(options.title).toContain("rebase");
    expect(options.consequence).toContain("rebase");
    expect(options.tone).toBe("danger");
  });

  it("merge is neutral and points at the escape hatch", () => {
    const options = confirmMergeBranch("feat", "main");
    expect(options.tone).toBe("neutral");
    expect(options.consequence).toContain("abort");
  });

  it("reverting a merge explains the mainline choice rather than just asking", () => {
    expect(confirmRevertMerge("a1b2c3d4").consequence).toContain("FIRST parent");
  });
});

describe("per-repo discard recoverability", () => {
  it("asks for no confirm until a repo is observed unrecoverable", () => {
    expect(discardRequiresConfirm(EMPTY_DISCARD_RECOVERABILITY, "/repo")).toBe(false);
  });

  it("one observation of recoverable:false flips the repo permanently", () => {
    let state = noteDiscardRecoverability(EMPTY_DISCARD_RECOVERABILITY, "/repo", false);
    expect(discardRequiresConfirm(state, "/repo")).toBe(true);
    // A later success does not undo it — an old git will not get newer.
    state = noteDiscardRecoverability(state, "/repo", true);
    expect(discardRequiresConfirm(state, "/repo")).toBe(true);
  });

  it("is scoped per repo", () => {
    const state = noteDiscardRecoverability(EMPTY_DISCARD_RECOVERABILITY, "/old", false);
    expect(discardRequiresConfirm(state, "/new")).toBe(false);
  });

  it("keeps identity when nothing changes, so consumers do not re-render", () => {
    const state = noteDiscardRecoverability(EMPTY_DISCARD_RECOVERABILITY, "/repo", false);
    expect(noteDiscardRecoverability(state, "/repo", false)).toBe(state);
    expect(noteDiscardRecoverability(state, "/other", true)).toBe(state);
  });
});
