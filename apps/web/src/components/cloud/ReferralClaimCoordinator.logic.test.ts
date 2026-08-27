import { describe, expect, it } from "vite-plus/test";

import { claimReferralWithRetry, referralClaimLoadState } from "./ReferralClaimCoordinator.logic";

describe("referralClaimLoadState", () => {
  it("only prompts sign-in for a referral captured on the current load", () => {
    expect(referralClaimLoadState("FROM_URL", "FROM_STORAGE")).toEqual({
      referralCode: "FROM_URL",
      shouldPromptSignIn: true,
    });
    expect(referralClaimLoadState(null, "FROM_STORAGE")).toEqual({
      referralCode: "FROM_STORAGE",
      shouldPromptSignIn: false,
    });
  });
});

describe("claimReferralWithRetry", () => {
  it("retries transient failures with bounded backoff", async () => {
    const results = ["failure", "failure", "success"] as const;
    const delays: number[] = [];
    let attempts = 0;

    const result = await claimReferralWithRetry({
      claim: async () => results[attempts++] ?? "failure",
      shouldRetry: (claimResult) => claimResult === "failure",
      wait: async (delay) => {
        delays.push(delay);
      },
    });

    expect(result).toBe("success");
    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 1_000]);
  });

  it("stops after three retries", async () => {
    let attempts = 0;

    const result = await claimReferralWithRetry({
      claim: async () => {
        attempts += 1;
        return "failure";
      },
      shouldRetry: () => true,
      wait: async () => undefined,
    });

    expect(result).toBe("failure");
    expect(attempts).toBe(4);
  });
});
