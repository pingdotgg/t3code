import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
// A namespace import, so a missing export fails its test on an assertion.
import * as ViewModel from "./prsViewModel.ts";

const { prsCheckoutLabel, prsCheckoutReceipt } = ViewModel;
const options = (handoff) => {
  NodeAssert.equal(typeof ViewModel.prsCheckoutOptions, "function");
  return ViewModel.prsCheckoutOptions(handoff);
};

const prepared = (overrides = {}) => ({
  pullRequest: {
    number: 7,
    title: "t",
    url: "https://github.com/o/r/pull/7",
    baseBranch: "main",
    headBranch: "feat",
    state: "open",
  },
  branch: "feat",
  worktreePath: "/repo/.t3/worktrees/feat",
  isOnPullRequestHead: true,
  ...overrides,
});

NodeTest.describe("checkout pull request", () => {
  NodeTest.it("offers native's two places, worktree first", () => {
    for (const handoff of [true, false]) {
      NodeAssert.deepEqual(
        options(handoff).map((option) => [option.mode, option.label]),
        [
          ["worktree", "In a separate worktree"],
          ["local", "In this repository"],
        ],
      );
      NodeAssert.equal(
        options(handoff)[1].description,
        "Switches the branch you are working in, like `gh pr checkout`.",
      );
    }
  });

  // The host opens the thread; a host without the handoff opens none, so none is claimed.
  NodeTest.it("promises a thread with the worktree only where the host opens one", () => {
    NodeAssert.equal(
      options(true)[0].description,
      "Its own folder and thread. Nothing you have open moves.",
    );
    NodeAssert.equal(options(false)[0].description, "Its own folder. Nothing you have open moves.");
  });

  NodeTest.it("reads Checking out... only while its own checkout runs", () => {
    NodeAssert.equal(prsCheckoutLabel(false), "Check out");
    NodeAssert.equal(prsCheckoutLabel(true), "Checking out...");
  });

  NodeTest.it("says where a finished checkout landed", () => {
    NodeAssert.deepEqual(prsCheckoutReceipt("worktree", { ok: true, value: prepared() }), {
      tone: "success",
      title: "Checked out",
      description: "The pull request is in its own worktree at /repo/.t3/worktrees/feat.",
    });
    NodeAssert.deepEqual(
      prsCheckoutReceipt("local", { ok: true, value: prepared({ worktreePath: null }) }),
      {
        tone: "success",
        title: "Checked out here",
        description: "This repository is on the pull request's branch.",
      },
    );
  });

  // An unverified head is not proof of older code or of local work, so neither is claimed.
  NodeTest.it("warns when the latest commits could not be confirmed", () => {
    NodeAssert.deepEqual(
      prsCheckoutReceipt("worktree", {
        ok: true,
        value: prepared({ isOnPullRequestHead: false }),
      }),
      {
        tone: "warning",
        title: "Checked out, but the latest commits are unconfirmed",
        description:
          "The pull request's latest commits could not be confirmed or applied here, so this checkout may be behind the pull request.",
      },
    );
  });

  NodeTest.it("passes the host's own sentence through on failure", () => {
    NodeAssert.deepEqual(
      prsCheckoutReceipt("local", { ok: false, detail: "Branch is checked out elsewhere." }),
      {
        tone: "error",
        title: "Could not prepare the pull request checkout",
        description: "Branch is checked out elsewhere.",
      },
    );
  });
});
