import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { prsBranchChips } from "./prsViewModel.ts";
import * as PrsViewModel from "./prsViewModel.ts";

const stack = (numbers) => ({
  id: "s",
  number: 9,
  url: "https://github.com/o/r/stacks/9",
  base: "main",
  layers: numbers.map((number) => ({ number, headBranch: `b${number}`, state: "open" })),
});

NodeTest.describe("branch chips", () => {
  NodeTest.it("reads base ← head, each name on hover, the arrow named", () => {
    NodeAssert.deepEqual(prsBranchChips({ baseBranch: "main", headBranch: "feat/x" }, false), {
      base: { text: "main", tooltip: "main", stacked: false },
      head: { text: "feat/x", tooltip: "feat/x" },
      arrowLabel: "receives changes from",
    });
  });

  NodeTest.it("names a stacked base the way native's tooltip does", () => {
    const chips = prsBranchChips({ baseBranch: "b1", headBranch: "b2" }, true);
    NodeAssert.deepEqual(chips.base, { text: "b1", tooltip: "Stacked on b1", stacked: true });
  });

  NodeTest.it(
    "is stacked when the base is not the repository's default ref, as native asks",
    () => {
      const stacked = PrsViewModel.prsStackedOnDefault ?? (() => null);
      const local = [{ name: "main", isDefault: true, current: false, worktreePath: null }];
      NodeAssert.equal(stacked("main", local), false);
      NodeAssert.equal(stacked("b2", local), true);
      const remote = [
        {
          name: "origin/main",
          isRemote: true,
          remoteName: "origin",
          isDefault: true,
          current: false,
          worktreePath: null,
        },
      ];
      NodeAssert.equal(stacked("main", remote), false);
      NodeAssert.equal(stacked("release", remote), true);
      // No known default, no badge.
      NodeAssert.equal(stacked("b2", []), false);
    },
  );
});
