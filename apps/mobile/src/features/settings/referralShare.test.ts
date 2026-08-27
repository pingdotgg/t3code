import { describe, expect, it, vi } from "vite-plus/test";

import { shareReferralLink } from "./referralShare";

describe("mobile referral sharing", () => {
  it("treats a resolved native dismissal as a no-op", async () => {
    const share = vi.fn().mockResolvedValue({ action: "dismissedAction" });

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

  it("propagates native sharing failures to the screen", async () => {
    const failure = new Error("Native share failed");
    const share = vi.fn().mockRejectedValue(failure);

    await expect(
      shareReferralLink("https://app.t3.codes/?ref=ABCD1234EFAB5678", share),
    ).rejects.toBe(failure);
  });

  it("does not open an empty share sheet", async () => {
    const share = vi.fn();

    await shareReferralLink("", share);

    expect(share).not.toHaveBeenCalled();
  });
});
