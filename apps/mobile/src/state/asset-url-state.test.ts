import { describe, expect, it } from "@effect/vitest";

import { deriveAssetUrlState } from "./asset-url-state";

const SUCCESS = { _tag: "Success" as const, url: "https://environment.example/api/assets/abc" };

describe("deriveAssetUrlState", () => {
  it("passes a resolved URL through on a live environment", () => {
    expect(deriveAssetUrlState({ connectionPhase: "connected", shared: SUCCESS })).toEqual(SUCCESS);
  });

  it("waits while the query is pending and the environment is still reachable", () => {
    for (const connectionPhase of ["available", "connecting", "connected"] as const) {
      expect(deriveAssetUrlState({ connectionPhase, shared: { _tag: "Loading" } })).toEqual({
        _tag: "Loading",
      });
    }
  });

  it("stops waiting once the environment is offline, retrying, or in error", () => {
    for (const connectionPhase of ["offline", "reconnecting", "error"] as const) {
      expect(deriveAssetUrlState({ connectionPhase, shared: { _tag: "Loading" } })).toEqual({
        _tag: "Failure",
        reason: "disconnected",
      });
    }
  });

  // A dead environment fails the URL query itself, so the query outcome alone
  // cannot tell a missing file from a missing connection.
  it("reports disconnected when the query failed while the environment is down", () => {
    for (const connectionPhase of ["available", "offline", "reconnecting", "error"] as const) {
      expect(deriveAssetUrlState({ connectionPhase, shared: { _tag: "Failure" } })).toEqual({
        _tag: "Failure",
        reason: "disconnected",
      });
    }
  });

  it("does not hand out a resolved URL for a disconnected environment", () => {
    for (const connectionPhase of ["offline", "reconnecting", "error"] as const) {
      expect(deriveAssetUrlState({ connectionPhase, shared: SUCCESS })).toEqual({
        _tag: "Failure",
        reason: "disconnected",
      });
    }
  });

  it("reports a failed query on a connected environment", () => {
    expect(
      deriveAssetUrlState({ connectionPhase: "connected", shared: { _tag: "Failure" } }),
    ).toEqual({ _tag: "Failure", reason: "failed" });
  });
});
