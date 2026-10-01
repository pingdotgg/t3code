import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import * as PrsViewModel from "./prsViewModel.ts";

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
  capabilities: { stacks: true, stackActions: true },
  viewerPermissions: { actions: [], stackRebase: true },
  ...overrides,
});
const write = { operations: { "prs.runAction": true }, actions: ["update-branch"] };

NodeTest.describe("rebase stack", () => {
  NodeTest.it("rebases every unmerged layer, targeting the top, pinned to their heads", () => {
    const plan = PrsViewModel.prsStackRebasePlan?.(
      stack([layer(1, { state: "merged" }), layer(2), layer(3)]),
    );
    NodeAssert.deepEqual(
      plan?.layers.map((entry) => entry.number),
      [2, 3],
    );
    NodeAssert.equal(plan.disabled, false);
    NodeAssert.deepEqual(plan.input, {
      number: 3,
      action: "update-branch",
      updateMethod: "rebase",
      stackNumber: 40,
      expectedStackHeads: [
        { number: 2, headSha: "sha2" },
        { number: 3, headSha: "sha3" },
      ],
    });
    NodeAssert.equal(plan.confirmTitle, "Rebase 2 pull requests?");
    NodeAssert.equal(
      plan.confirmDescription,
      "Rebase the remote branches from bottom to top onto main. This rewrites branch history and may restart checks. If a layer fails, earlier updates remain.",
    );
  });

  NodeTest.it("is disabled by an unknown head or a closed layer, or with nothing to rebase", () => {
    const plan = (layers) => PrsViewModel.prsStackRebasePlan?.(stack(layers));
    NodeAssert.equal(plan([layer(1, { headSha: undefined }), layer(2)])?.disabled, true);
    NodeAssert.equal(plan([layer(1, { state: "closed" }), layer(2)])?.disabled, true);
    NodeAssert.equal(plan([layer(1, { state: "merged" })])?.disabled, true);
  });

  NodeTest.it("needs stack actions, the viewer's rebase permission and a declared update", () => {
    const can = (d, w = write) => PrsViewModel.prsCanRebaseStack?.(d, w) ?? null;
    NodeAssert.equal(can(detail()), true);
    NodeAssert.equal(can(detail({ viewerPermissions: { actions: [] } })), false);
    NodeAssert.equal(can(detail({ capabilities: { stacks: true, stackActions: false } })), false);
    NodeAssert.equal(can(detail(), { operations: { "prs.runAction": true }, actions: [] }), false);
  });

  NodeTest.it("reports the outcome in native's words", () => {
    NodeAssert.deepEqual(PrsViewModel.prsStackRebaseReceipt?.({ ok: true }), {
      tone: "success",
      title: "Stack rebased",
      description: null,
    });
    NodeAssert.deepEqual(PrsViewModel.prsStackRebaseReceipt?.({ ok: false, detail: "moved" }), {
      tone: "error",
      title: "Stack operation did not complete",
      description: "moved",
    });
  });
});
