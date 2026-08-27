import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildReferralShareData,
  captureReferralCodeFromUrl,
  clearReferralCodeFromCurrentUrl,
  clearPendingReferralCode,
  PENDING_REFERRAL_CODE_STORAGE_KEY,
  persistPendingReferralCode,
  readPendingReferralCode,
  referralCodeFromUrl,
  urlWithoutMatchingReferralCode,
  urlWithoutReferralCode,
} from "./referralLinks";

describe("referralLinks", () => {
  afterEach(() => {
    clearPendingReferralCode(() => ({ removeItem: vi.fn() }));
  });

  it("clears a pending code without exposing storage failures", () => {
    const removeItem = vi.fn();
    clearPendingReferralCode(() => ({ removeItem }));
    expect(removeItem).toHaveBeenCalledWith(PENDING_REFERRAL_CODE_STORAGE_KEY);

    expect(() =>
      clearPendingReferralCode(() => {
        throw new Error("storage unavailable");
      }),
    ).not.toThrow();
  });

  it("normalizes a pending referral read from storage", () => {
    const storage = {
      getItem: vi.fn(() => "abcd1234efab5678"),
    };

    expect(readPendingReferralCode(() => storage)).toBe("ABCD1234EFAB5678");
    expect(storage.getItem).toHaveBeenCalledWith(PENDING_REFERRAL_CODE_STORAGE_KEY);
  });

  it("treats blocked browser storage as empty", () => {
    expect(
      readPendingReferralCode(() => {
        throw new Error("Storage access denied");
      }),
    ).toBeNull();
  });

  it("keeps a captured code available for linking when browser storage is blocked", () => {
    const url = new URL("https://app.t3.codes/?ref=abcd1234efab5678");
    const blockedStorage = () => {
      throw new Error("Storage access denied");
    };

    expect(
      captureReferralCodeFromUrl(url, (referralCode) =>
        persistPendingReferralCode(referralCode, blockedStorage),
      ),
    ).toEqual({
      referralCode: "ABCD1234EFAB5678",
      cleanedUrl: null,
    });
    expect(readPendingReferralCode(blockedStorage)).toBe("ABCD1234EFAB5678");
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

  it("removes a rejected referral from the current URL", () => {
    const replaceUrl = vi.fn();

    clearReferralCodeFromCurrentUrl(
      "abcd1234efab5678",
      () => new URL("https://app.t3.codes/?channel=nightly&ref=ABCD1234EFAB5678#thread"),
      replaceUrl,
    );

    expect(replaceUrl).toHaveBeenCalledWith("/?channel=nightly#thread");
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
