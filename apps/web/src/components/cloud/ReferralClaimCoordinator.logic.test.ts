import { describe, expect, it } from "vite-plus/test";

import {
  claimReferralWithRetry,
  isCurrentReferralClaimAttempt,
} from "./ReferralClaimCoordinator.logic";

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

  it("does not retry after cancellation during backoff", async () => {
    let attempts = 0;
    let isCurrent = true;

    const result = await claimReferralWithRetry({
      claim: async () => {
        attempts += 1;
        return "failure";
      },
      shouldContinue: () => isCurrent,
      shouldRetry: () => true,
      wait: async () => {
        isCurrent = false;
      },
    });

    expect(result).toBe("failure");
    expect(attempts).toBe(1);
  });
});

describe("isCurrentReferralClaimAttempt", () => {
  it("rejects a result after the account changes or the effect is cancelled", () => {
    const accountAAttempt = { key: "account-a:ABCD1234EFAB5678" };

    expect(isCurrentReferralClaimAttempt(false, accountAAttempt, accountAAttempt)).toBe(true);
    expect(
      isCurrentReferralClaimAttempt(false, { key: "account-b:ABCD1234EFAB5678" }, accountAAttempt),
    ).toBe(false);
    expect(isCurrentReferralClaimAttempt(true, accountAAttempt, accountAAttempt)).toBe(false);
  });

  it("rejects a stale result when a same-key successor is active", () => {
    const staleAttempt = { key: "account-a:ABCD1234EFAB5678" };
    const successorAttempt = { key: "account-a:ABCD1234EFAB5678" };

    expect(isCurrentReferralClaimAttempt(false, successorAttempt, staleAttempt)).toBe(false);
    expect(isCurrentReferralClaimAttempt(false, successorAttempt, successorAttempt)).toBe(true);
  });
});
