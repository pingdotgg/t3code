import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  prsAllowedMergeMethods,
  prsCanMergeStack,
  prsStackMergePlan,
  prsStackMergeReceipt,
} from "./prsViewModel.ts";

const layer = (number, overrides = {}) => ({
  number,
  headBranch: `b${number}`,
  headSha: `sha${number}`,
  state: "open",
  ...overrides,
});
const stack = (layers) => ({
  id: "s",
  number: 40,
  url: "https://github.com/o/r/stacks/40",
  base: "main",
  layers,
});

const detail = (overrides = {}) => ({
  capabilities: {
    actions: ["merge"],
    mergeMethods: ["merge", "squash"],
    stacks: true,
    stackActions: true,
  },
  viewerPermissions: { actions: ["merge"] },
  mergeCapabilities: { merge: false, squash: true, rebase: true },
  ...overrides,
});
const write = { operations: { "prs.runAction": true }, actions: ["merge"] };

NodeTest.describe("merge stack", () => {
  NodeTest.it("merges this layer and every unmerged layer below it, pinned to their heads", () => {
    const plan = prsStackMergePlan(
      stack([layer(1, { state: "merged" }), layer(2), layer(3), layer(4)]),
      3,
      "squash",
    );
    NodeAssert.equal(plan.visible, true);
    NodeAssert.equal(plan.disabled, false);
    NodeAssert.deepEqual(
      plan.layers.map((entry) => entry.number),
      [2, 3],
    );
    NodeAssert.deepEqual(plan.input, {
      number: 3,
      action: "merge",
      mergeMethod: "squash",
      stackNumber: 40,
      expectedStackHeads: [
        { number: 2, headSha: "sha2" },
        { number: 3, headSha: "sha3" },
      ],
    });
    NodeAssert.equal(plan.label, "Merge stack");
    NodeAssert.equal(plan.tooltip, "Merge stack through #3 into main (2 pull requests)");
    NodeAssert.equal(plan.confirmTitle, "Merge 2 pull requests?");
    NodeAssert.equal(
      plan.confirmDescription,
      "Merge #3 and its unmerged layers below into main using squash. GitHub checks their rules before merging or queueing them and rebases the remaining stack after merging.",
    );
    NodeAssert.equal(plan.blockedNote, null);
  });

  NodeTest.it("says 1 pull request in the singular", () => {
    const plan = prsStackMergePlan(stack([layer(5), layer(6)]), 5, "merge");
    NodeAssert.equal(plan.tooltip, "Merge stack through #5 into main (1 pull request)");
  });

  NodeTest.it("hides for a layer that is not open and disables on unready layers", () => {
    NodeAssert.equal(
      prsStackMergePlan(stack([layer(1, { state: "merged" })]), 1, "merge").visible,
      false,
    );
    const draftBelow = prsStackMergePlan(
      stack([layer(1, { isDraft: true }), layer(2)]),
      2,
      "merge",
    );
    NodeAssert.equal(draftBelow.disabled, true);
    NodeAssert.equal(
      draftBelow.blockedNote,
      "Every layer being merged must be open and ready for review.",
    );
    const closedBelow = prsStackMergePlan(
      stack([layer(1, { state: "closed" }), layer(2)]),
      2,
      "merge",
    );
    NodeAssert.equal(closedBelow.disabled, true);
    const unknownHead = prsStackMergePlan(
      stack([layer(1, { headSha: undefined }), layer(2)]),
      2,
      "merge",
    );
    NodeAssert.equal(unknownHead.disabled, true);
    NodeAssert.equal(unknownHead.blockedNote, null);
    NodeAssert.equal(prsStackMergePlan(stack([layer(1)]), 9, "merge").visible, false);
  });

  NodeTest.it("offers the merge only where host, viewer and repository all allow it", () => {
    NodeAssert.deepEqual(prsAllowedMergeMethods(detail()), ["squash"]);
    NodeAssert.equal(prsCanMergeStack(detail(), write), true);
    NodeAssert.equal(
      prsCanMergeStack(
        detail({ capabilities: { ...detail().capabilities, stackActions: false } }),
        write,
      ),
      false,
    );
    NodeAssert.equal(
      prsCanMergeStack(detail({ viewerPermissions: { actions: [] } }), write),
      false,
    );
    NodeAssert.equal(
      prsCanMergeStack(
        detail({ mergeCapabilities: { merge: false, squash: false, rebase: false } }),
        write,
      ),
      false,
    );
    NodeAssert.equal(
      prsCanMergeStack(detail(), { operations: { "prs.runAction": false }, actions: ["merge"] }),
      false,
    );
    NodeAssert.equal(
      prsCanMergeStack(detail(), { operations: { "prs.runAction": true }, actions: [] }),
      false,
    );
  });

  NodeTest.it("reports the outcome in native's words", () => {
    NodeAssert.deepEqual(prsStackMergeReceipt({ ok: true }), {
      tone: "success",
      title: "Stack merge request completed",
      description: "GitHub merged the stack or added it to its merge queue.",
    });
    NodeAssert.deepEqual(prsStackMergeReceipt({ ok: false, detail: "stale heads" }), {
      tone: "error",
      title: "Stack operation did not complete",
      description: "stale heads",
    });
  });
});

NodeTest.describe("merge method preference", () => {
  NodeTest.it(
    "resolves the current pick, then the project setting, then the last pick",
    async () => {
      const { prsResolveMergeMethod } = await import("./prsViewModel.ts");
      const resolve = (...args) => prsResolveMergeMethod?.(...args) ?? null;
      NodeAssert.equal(resolve(["merge", "squash"], null, "squash", "merge"), "squash");
      NodeAssert.equal(resolve(["merge", "squash"], "merge", "squash", "merge"), "merge");
      NodeAssert.equal(resolve(["merge", "squash"], null, undefined, "squash"), "squash");
      // A preference the repository does not allow falls through.
      NodeAssert.equal(resolve(["merge", "squash"], null, "rebase", null), "merge");
      NodeAssert.equal(resolve([], null, "squash", null), "merge");
    },
  );
});
