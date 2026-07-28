import { describe, expect, it, vi } from "vite-plus/test";

import {
  refreshVcsRefsAfterQueryReset,
  refreshVcsRefsOnMenuOpen,
  resetVcsRefQueriesOnMenuClose,
  resetVcsRefQueryOrRefresh,
} from "./vcsRefMenuRefresh";

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

  it("resets visible and backing queries and cancels pending refreshes on close", () => {
    const resetVisibleQuery = vi.fn();
    const resetRefQuery = vi.fn();
    const cancelPendingRefresh = vi.fn();

    resetVcsRefQueriesOnMenuClose(false, resetVisibleQuery, resetRefQuery, cancelPendingRefresh);

    expect(resetVisibleQuery).toHaveBeenCalledOnce();
    expect(resetRefQuery).toHaveBeenCalledOnce();
    expect(cancelPendingRefresh).toHaveBeenCalledOnce();
  });

  it("does not complete a pending query-reset refresh after close", () => {
    const clearPendingRefresh = vi.fn();
    const refreshRefs = vi.fn();

    refreshVcsRefsAfterQueryReset(false, true, "", clearPendingRefresh, refreshRefs);

    expect(clearPendingRefresh).not.toHaveBeenCalled();
    expect(refreshRefs).not.toHaveBeenCalled();
  });

  it("refreshes open-menu refs after their backing query resets", () => {
    const clearPendingRefresh = vi.fn();
    const refreshRefs = vi.fn();

    refreshVcsRefsAfterQueryReset(true, true, "", clearPendingRefresh, refreshRefs);

    expect(clearPendingRefresh).toHaveBeenCalledOnce();
    expect(refreshRefs).toHaveBeenCalledOnce();
  });

  it("resets a previous query without refreshing its stale ref atoms", () => {
    const resetQuery = vi.fn();
    const refreshLocalRefs = vi.fn();
    const refreshRemoteRefs = vi.fn();

    resetVcsRefQueryOrRefresh("feature", resetQuery, refreshLocalRefs, refreshRemoteRefs);

    expect(resetQuery).toHaveBeenCalledOnce();
    expect(refreshLocalRefs).not.toHaveBeenCalled();
    expect(refreshRemoteRefs).not.toHaveBeenCalled();
  });

  it("refreshes current ref atoms when there is no previous query to reset", () => {
    const resetQuery = vi.fn();
    const refreshLocalRefs = vi.fn();
    const refreshRemoteRefs = vi.fn();

    resetVcsRefQueryOrRefresh("  ", resetQuery, refreshLocalRefs, refreshRemoteRefs);

    expect(resetQuery).not.toHaveBeenCalled();
    expect(refreshLocalRefs).toHaveBeenCalledOnce();
    expect(refreshRemoteRefs).toHaveBeenCalledOnce();
  });
});
