import { describe, expect, it } from "vite-plus/test";

import {
  buildReferralShareData,
  captureReferralCodeFromUrl,
  referralCodeFromUrl,
  urlWithoutReferralCode,
} from "./referralLinks";

describe("referralLinks", () => {
  it("reads and removes only the referral parameter", () => {
    const url = new URL("https://app.t3.codes/?channel=nightly&ref=abcd1234efab5678#thread");
    expect(referralCodeFromUrl(url)).toBe("ABCD1234EFAB5678");
    expect(urlWithoutReferralCode(url)).toBe("/?channel=nightly#thread");
  });

  it("only cleans the URL after the referral code is persisted", () => {
    const url = new URL("https://app.t3.codes/?ref=abcd1234efab5678#thread");

    expect(
      captureReferralCodeFromUrl(url, () => {
        throw new Error("storage unavailable");
      }),
    ).toEqual({ referralCode: "ABCD1234EFAB5678", cleanedUrl: null });

    expect(captureReferralCodeFromUrl(url, () => undefined)).toEqual({
      referralCode: "ABCD1234EFAB5678",
      cleanedUrl: "/#thread",
    });
  });

  it("embeds the claim URL in web share text even when a share target drops the url field", () => {
    const referralLink = "https://app.t3.codes/?ref=ABCD1234EFAB5678";
    const shareData = buildReferralShareData(referralLink);

    expect(shareData).toMatchObject({
      title: "T3 Code referral",
      url: referralLink,
    });
    expect(shareData.text).toContain(referralLink);
  });
});
