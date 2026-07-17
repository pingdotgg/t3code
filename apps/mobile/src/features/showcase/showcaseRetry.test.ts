import { assert, it } from "@effect/vitest";

import { retryShowcaseOperation } from "./showcaseRetry";

it("retries a failed showcase operation until it succeeds", async () => {
  let attempts = 0;
  const succeeded = await retryShowcaseOperation(
    async () => {
      attempts += 1;
      return attempts === 3;
    },
    { isCancelled: () => false, retryDelayMs: 0 },
  );

  assert.equal(succeeded, true);
  assert.equal(attempts, 3);
});

it("recovers when a showcase operation attempt hangs", async () => {
  let attempts = 0;
  const succeeded = await retryShowcaseOperation(
    () => {
      attempts += 1;
      return attempts === 1 ? new Promise<boolean>(() => undefined) : Promise.resolve(true);
    },
    { isCancelled: () => false, attemptTimeoutMs: 1, retryDelayMs: 0 },
  );

  assert.equal(succeeded, true);
  assert.equal(attempts, 2);
});

it("stops retrying when the owning showcase effect is cancelled", async () => {
  let cancelled = false;
  const succeeded = await retryShowcaseOperation(
    async () => {
      cancelled = true;
      return false;
    },
    { isCancelled: () => cancelled, retryDelayMs: 0 },
  );

  assert.equal(succeeded, false);
});
