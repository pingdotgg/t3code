import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
// A namespace import, so a missing export fails each test on its own assertion.
import * as ViewModel from "./prsViewModel.ts";

const control = (detail, handoff = null) => {
  NodeAssert.equal(typeof ViewModel.prsResolveConflictsControl, "function");
  return ViewModel.prsResolveConflictsControl(detail, handoff);
};
const conflicting = { state: "open", mergeability: "conflicting" };

NodeTest.describe("resolve conflicts", () => {
  NodeTest.it("shows only on an open pull request that conflicts with its base", () => {
    NodeAssert.equal(control({ state: "open", mergeability: "mergeable" }).visible, false);
    NodeAssert.equal(control({ state: "open", mergeability: "unknown" }).visible, false);
    NodeAssert.equal(control({ state: "merged", mergeability: "conflicting" }).visible, false);
    NodeAssert.equal(control({ state: "closed", mergeability: "conflicting" }).visible, false);
    NodeAssert.deepEqual(control(conflicting), {
      visible: true,
      label: "Resolve conflicts",
      disabled: false,
    });
  });

  NodeTest.it("reads Preparing... while its own handoff runs, and waits for any other", () => {
    NodeAssert.deepEqual(control(conflicting, "conflicts"), {
      visible: true,
      label: "Preparing...",
      disabled: true,
    });
    NodeAssert.deepEqual(control(conflicting, "checkout:worktree"), {
      visible: true,
      label: "Resolve conflicts",
      disabled: true,
    });
  });
});
