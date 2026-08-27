import { describe, expect, it, vi } from "vite-plus/test";

import { shareReferralLink } from "./referralShare";

describe("mobile referral sharing", () => {
  it("treats dismissing the native share sheet as a no-op", async () => {
    const share = vi.fn().mockRejectedValue(new Error("Share dismissed"));

    await expect(
      shareReferralLink("https://app.t3.codes/?ref=ABCD1234EFAB5678", share),
    ).resolves.toBeUndefined();

    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("https://app.t3.codes/?ref=ABCD1234EFAB5678"),
      }),
      expect.objectContaining({ dialogTitle: "Share referral link" }),
    );
  });

  it("does not open an empty share sheet", async () => {
    const share = vi.fn();

    await shareReferralLink("", share);

    expect(share).not.toHaveBeenCalled();
  });
});
