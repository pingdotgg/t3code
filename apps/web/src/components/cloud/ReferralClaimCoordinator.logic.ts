const REFERRAL_CLAIM_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

function waitForRetry(delay: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delay));
}

export function referralClaimLoadState(
  capturedCode: string | null,
  storedCode: string | null,
): { referralCode: string | null; shouldPromptSignIn: boolean } {
  return {
    referralCode: capturedCode ?? storedCode,
    shouldPromptSignIn: capturedCode !== null,
  };
}

export async function claimReferralWithRetry<Result>({
  claim,
  shouldRetry,
  wait = waitForRetry,
}: {
  readonly claim: () => Promise<Result>;
  readonly shouldRetry: (result: Result) => boolean;
  readonly wait?: (delay: number) => Promise<void>;
}): Promise<Result> {
  let failedAttempts = 0;
  while (true) {
    const result = await claim();
    if (!shouldRetry(result)) return result;

    const retryDelay = REFERRAL_CLAIM_RETRY_DELAYS_MS[failedAttempts];
    if (retryDelay === undefined) return result;
    failedAttempts += 1;
    await wait(retryDelay);
  }
}
