import { describe, expect, it } from "vite-plus/test";

import { deriveInboxViewState } from "./inboxViewState";

const NO_ROWS = [] as const;
const SOME_ROWS = [{}] as const;

describe("deriveInboxViewState", () => {
  // ── skeleton ──────────────────────────────────────────────────────────────

  it("returns skeleton during the initial load (loading, not refreshing, no rows)", () => {
    const result = deriveInboxViewState({
      loading: true,
      refreshing: false,
      rows: NO_ROWS,
      error: null,
      partialError: null,
    });
    expect(result.kind).toBe("skeleton");
  });

  it("does NOT return skeleton during pull-to-refresh (refreshing flag set)", () => {
    const result = deriveInboxViewState({
      loading: true,
      refreshing: true,
      rows: NO_ROWS,
      error: null,
      partialError: null,
    });
    expect(result.kind).not.toBe("skeleton");
  });

  it("does NOT return skeleton when rows are already present during a reload", () => {
    const result = deriveInboxViewState({
      loading: true,
      refreshing: false,
      rows: SOME_ROWS,
      error: null,
      partialError: null,
    });
    expect(result.kind).not.toBe("skeleton");
  });

  // ── error (full failure) ──────────────────────────────────────────────────

  it("returns error when load finished with zero rows and an error", () => {
    const result = deriveInboxViewState({
      loading: false,
      refreshing: false,
      rows: NO_ROWS,
      error: "Network timeout",
      partialError: null,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toBe("Network timeout");
  });

  it("does NOT show the success empty state on full failure", () => {
    const result = deriveInboxViewState({
      loading: false,
      refreshing: false,
      rows: NO_ROWS,
      error: "Server error",
      partialError: null,
    });
    expect(result.kind).not.toBe("empty");
  });

  // ── empty (all caught up) ─────────────────────────────────────────────────

  it("returns empty when load finished cleanly with zero rows", () => {
    const result = deriveInboxViewState({
      loading: false,
      refreshing: false,
      rows: NO_ROWS,
      error: null,
      partialError: null,
    });
    expect(result.kind).toBe("empty");
  });

  // ── list ──────────────────────────────────────────────────────────────────

  it("returns list with no partial error banner when all environments succeeded", () => {
    const result = deriveInboxViewState({
      loading: false,
      refreshing: false,
      rows: SOME_ROWS,
      error: null,
      partialError: null,
    });
    expect(result.kind).toBe("list");
    if (result.kind !== "list") throw new Error("expected list");
    expect(result.partialErrorMessage).toBeNull();
  });

  it("returns list with a partial error banner when some environments failed", () => {
    const result = deriveInboxViewState({
      loading: false,
      refreshing: false,
      rows: SOME_ROWS,
      error: null,
      partialError: "Some boards couldn't be loaded — pull to refresh to retry.",
    });
    expect(result.kind).toBe("list");
    if (result.kind !== "list") throw new Error("expected list");
    expect(result.partialErrorMessage).toBe(
      "Some boards couldn't be loaded — pull to refresh to retry.",
    );
  });

  it("returns list even while a reload is in flight (rows already present)", () => {
    const result = deriveInboxViewState({
      loading: true,
      refreshing: false,
      rows: SOME_ROWS,
      error: null,
      partialError: null,
    });
    expect(result.kind).toBe("list");
  });
});
