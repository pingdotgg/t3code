import { describe, expect, it } from "vite-plus/test";

import { claimPairingToken } from "./PairingRouteSurface.logic";

describe("claimPairingToken", () => {
  it("claims each pairing token once", () => {
    const attemptedTokens = new Set<string>();

    expect(claimPairingToken("first-token", attemptedTokens)).toBe("first-token");
    expect(claimPairingToken("first-token", attemptedTokens)).toBeNull();
    expect(claimPairingToken("second-token", attemptedTokens)).toBe("second-token");
  });

  it("ignores a URL without a pairing token", () => {
    expect(claimPairingToken(null, new Set<string>())).toBeNull();
  });
});
