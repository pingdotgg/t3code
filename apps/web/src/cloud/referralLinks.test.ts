import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildReferralShareData,
  captureReferralCodeFromUrl,
  PENDING_REFERRAL_CODE_STORAGE_KEY,
  readPendingReferralCode,
  referralCodeFromUrl,
  urlWithoutMatchingReferralCode,
  urlWithoutReferralCode,
} from "./referralLinks";

describe("referralLinks", () => {
  it("normalizes a pending referral read from storage", () => {
    const storage = {
      getItem: vi.fn(() => "abcd1234efab5678"),
    };

    expect(readPendingReferralCode(storage)).toBe("ABCD1234EFAB5678");
    expect(storage.getItem).toHaveBeenCalledWith(PENDING_REFERRAL_CODE_STORAGE_KEY);
  });

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

  it("does not clear a newer referral from the current URL", () => {
    const currentUrl = new URL("https://app.t3.codes/?ref=BBBBBBBBBBBBBBBB#thread");

    expect(urlWithoutMatchingReferralCode(currentUrl, "AAAAAAAAAAAAAAAA")).toBeNull();
    expect(urlWithoutMatchingReferralCode(currentUrl, "bbbbbbbbbbbbbbbb")).toBe("/#thread");
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
