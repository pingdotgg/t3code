import { describe, expect, it } from "@effect/vitest";

import { deriveAssetUrlState } from "./asset-url-state";

const SUCCESS = {
  _tag: "Success" as const,
  url: "https://environment.example/api/assets/abc",
  expiresAt: Number.MAX_SAFE_INTEGER,
};

describe("deriveAssetUrlState", () => {
  it("stops waiting once the environment is offline, retrying, or in error", () => {
    for (const connectionPhase of ["offline", "reconnecting", "error"] as const) {
      expect(deriveAssetUrlState({ connectionPhase, shared: { _tag: "Loading" } })).toEqual({
        _tag: "Failure",
        reason: "disconnected",
      });
    }
  });

  // regression: #9123 show an error instead of an endless preview spinner
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
});
