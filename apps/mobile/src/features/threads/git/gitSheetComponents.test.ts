import type { VcsStatusAccumulatedResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  compactStatusSummary,
  resolveGitOverviewContentStatus,
  statusSummary,
} from "./gitStatusPresentation";

describe("statusSummary", () => {
  it("keeps local dirty state visible while marking remote state unknown", () => {
    const status: VcsStatusAccumulatedResult = {
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

    expect(statusSummary(status)).toBe("1 file changed · Remote status unknown");
    expect(compactStatusSummary(status)).toBe("1 changed · Remote status unknown");
    expect(resolveGitOverviewContentStatus("ios", statusSummary(status))).toBe(
      "1 file changed · Remote status unknown",
    );
    expect(resolveGitOverviewContentStatus("android", statusSummary(status))).toBeNull();
  });
});
