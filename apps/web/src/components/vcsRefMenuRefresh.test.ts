import { describe, expect, it, vi } from "vite-plus/test";

import { refreshVcsRefsOnMenuOpen } from "./vcsRefMenuRefresh";

describe("ref menu open refreshes", () => {
  it("refreshes the composer branch-selector refs when its menu opens", () => {
    const refreshBranchRefs = vi.fn();

    refreshVcsRefsOnMenuOpen(true, refreshBranchRefs);

    expect(refreshBranchRefs).toHaveBeenCalledOnce();
  });

  it("refreshes both local and remote Diff comparison refs when its menu opens", () => {
    const refreshLocalRefs = vi.fn();
    const refreshRemoteRefs = vi.fn();

    refreshVcsRefsOnMenuOpen(true, refreshLocalRefs, refreshRemoteRefs);

    expect(refreshLocalRefs).toHaveBeenCalledOnce();
    expect(refreshRemoteRefs).toHaveBeenCalledOnce();
  });

  it("does not refresh refs when either menu closes", () => {
    const refreshLocalRefs = vi.fn();
    const refreshRemoteRefs = vi.fn();

    refreshVcsRefsOnMenuOpen(false, refreshLocalRefs, refreshRemoteRefs);

    expect(refreshLocalRefs).not.toHaveBeenCalled();
    expect(refreshRemoteRefs).not.toHaveBeenCalled();
  });
});
