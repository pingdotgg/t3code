import { describe, expect, it } from "vite-plus/test";

import { buildReferralLink, normalizeReferralCode } from "./referral.js";

describe("referral", () => {
  it("normalizes referral codes shared with separators", () => {
    expect(normalizeReferralCode(" abcd-1234-efab-5678 ")).toBe("ABCD1234EFAB5678");
    expect(normalizeReferralCode("not-a-code")).toBeNull();
  });

  it("builds a hosted referral link", () => {
    expect(buildReferralLink("https://app.t3.codes", "ABCD1234EFAB5678")).toBe(
      "https://app.t3.codes/?ref=ABCD1234EFAB5678",
    );
  });
});
