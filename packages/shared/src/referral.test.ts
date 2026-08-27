import { describe, expect, it } from "vite-plus/test";

import {
  buildReferralLink,
  buildReferralShareMessage,
  normalizeReferralCode,
  REFERRAL_SHARE_TITLE,
} from "./referral.js";

describe("referral", () => {
  it("normalizes referral codes shared with separators", () => {
    expect(normalizeReferralCode(" abcd-1234-efab-5678 ")).toBe("ABCD1234EFAB5678");
    expect(normalizeReferralCode("not-a-code")).toBeNull();
  });

  it("builds a hosted referral link", () => {
    expect(buildReferralLink("https://app.t3.codes/somewhere", "abcd-1234-efab-5678")).toBe(
      "https://app.t3.codes/?ref=ABCD1234EFAB5678",
    );
  });

  it("rejects malformed referral links before they can be shared", () => {
    expect(() => buildReferralLink("https://app.t3.codes", "not-a-code")).toThrow(
      "valid 16-character referral code",
    );
  });

  it("builds accurate cross-platform share copy", () => {
    const link = "https://app.t3.codes/?ref=ABCD1234EFAB5678";
    expect(REFERRAL_SHARE_TITLE).toBe("T3 Code referral");
    expect(buildReferralShareMessage(link)).toBe(
      `Try T3 Code with my referral. If you claim it before linking your first environment, I get 67 points.\n${link}`,
    );
    expect(buildReferralShareMessage(link, 100)).toContain("I get 100 points");
  });
});
