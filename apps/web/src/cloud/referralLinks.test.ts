import { describe, expect, it } from "vite-plus/test";

import { referralCodeFromUrl, urlWithoutReferralCode } from "./referralLinks";

describe("referralLinks", () => {
  it("reads and removes only the referral parameter", () => {
    const url = new URL("https://app.t3.codes/?channel=nightly&ref=abcd1234efab5678#thread");
    expect(referralCodeFromUrl(url)).toBe("ABCD1234EFAB5678");
    expect(urlWithoutReferralCode(url)).toBe("/?channel=nightly#thread");
  });
});
