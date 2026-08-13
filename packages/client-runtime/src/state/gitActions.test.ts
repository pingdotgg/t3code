import type { VcsStatusAccumulatedResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMenuItems, resolveQuickAction } from "./gitActions.ts";

const unknownRemoteStatus: VcsStatusAccumulatedResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/mobile-status",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "src/mobile.ts", insertions: 1, deletions: 0 }],
    insertions: 1,
    deletions: 0,
  },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  remoteStatusKnown: false,
};

describe("remote-unknown Git actions", () => {
  it("withholds remote-shaped menu and quick actions until remote status is known", () => {
    expect(buildMenuItems(unknownRemoteStatus, false, true)).toEqual([
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
    ]);
    expect(resolveQuickAction(unknownRemoteStatus, false, false, true)).toEqual({
      label: "Commit",
      disabled: false,
      kind: "run_action",
      action: "commit",
    });
  });

  it("reports remote status unavailable instead of treating clean placeholders as settled", () => {
    const cleanUnknownStatus = {
      ...unknownRemoteStatus,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    };

    expect(resolveQuickAction(cleanUnknownStatus, false, false, true)).toMatchObject({
      disabled: true,
      hint: "Remote Git status is unavailable.",
    });
  });

  it("restores the intended actions after the same status becomes known", () => {
    const knownStatus = { ...unknownRemoteStatus, remoteStatusKnown: true };

    expect(buildMenuItems(knownStatus, false, true)).toHaveLength(3);
    expect(resolveQuickAction(knownStatus, false, false, true)).toMatchObject({
      disabled: false,
      action: "commit_push_pr",
    });
  });
});
