import type { VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";
import * as actionRules from "./gitActions.ts";

function gitMatrix(rules: typeof actionRules, surface: "web" | "mobile") {
  const results: unknown[] = [];
  const reasons: unknown[] = [];
  for (let mask = 0; mask < 512; mask++) {
    const status: VcsStatusResult = {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: mask & 1 ? "feature/test" : null,
      hasWorkingTreeChanges: Boolean(mask & 2),
      hasUpstream: Boolean(mask & 4),
      aheadCount: mask & 8 ? 1 : 0,
      behindCount: mask & 16 ? 1 : 0,
      aheadOfDefaultCount: mask & 32 ? 1 : 0,
      pr:
        mask & 64
          ? {
              number: 1,
              title: "Example",
              url: "https://github.com/a/b/pull/1",
              state: "open",
              baseRef: "main",
              headRef: "feature/test",
            }
          : null,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    };
    const busy = Boolean(mask & 128);
    const remote = Boolean(mask & 256);
    results.push(rules.buildMenuItems(status, busy, remote, surface));
    for (const defaultRef of [false, true])
      results.push(rules.resolveQuickAction(status, busy, defaultRef, remote, surface));
    for (const id of ["commit", "push", "pr"] as const) {
      reasons.push(
        rules.getGitActionDisabledReason({
          item: { id, label: id, icon: id, disabled: true, kind: "open_dialog" },
          gitStatus: status,
          isBusy: busy,
          hasOriginRemote: remote,
          surface,
        }),
      );
    }
  }
  for (const busy of [false, true])
    results.push(
      rules.buildMenuItems(null, busy, false, surface),
      rules.resolveQuickAction(null, busy, false, false, surface),
    );
  for (const action of ["push", "create_pr", "commit_push", "commit_push_pr"] as const) {
    for (const includesCommit of [false, true])
      results.push(
        rules.resolveDefaultBranchActionDialogCopy({
          action,
          branchName: "main",
          includesCommit,
          surface,
        }),
      );
    for (const defaultRef of [false, true])
      results.push(rules.requiresDefaultBranchConfirmation(action, defaultRef));
  }
  return { actions: results, reasons };
}

// Frozen from the two original implementations at upstream ab6be13d438a.
// Each surface keeps its own 512-state menu, quick-action, disabled-reason, and dialog copy.
describe("original Git action policy matrices", () => {
  it.each([
    [
      "web",
      "58fa9fce55d1970fd4f4e8fb4e58e7b67e4b8d191e27371d14495943ef81477b",
      "847b9e30b8ad26f62b3f3952da3c4edcbb4339886c50cde025d2aa7677ac125c",
    ],
    [
      "mobile",
      "28944be3157340e7e50e474983592f4df8133a3106a345aec6095458f87e2617",
      "9a2b6518ce19d060d9fa8e77c636f0c06705c7cd9f87fb814a86fa4fd6932498",
    ],
  ] as const)(
    "preserves the complete %s policy and copy",
    async (surface, digest, reasonDigest) => {
      const matrix = gitMatrix(actionRules, surface);
      const sha256 = async (value: unknown) =>
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
          ),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
      assert.equal(await sha256(matrix.actions), digest);
      assert.equal(await sha256(matrix.reasons), reasonDigest);
    },
  );
});
