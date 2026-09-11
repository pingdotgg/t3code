// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { ms } from "itty-time";
// @ts-expect-error workflows "shared" package will be pulled in later
import type { ResolvedStepConfig, StepState } from "shared";

export function calcRetryDuration(config: ResolvedStepConfig, stepState: StepState): number {
  const { attemptedCount: attemptCount } = stepState;
  const { retries } = config;

  const delay = ms(retries.delay);

  switch (retries.backoff) {
    case "exponential": {
      return delay * Math.pow(2, attemptCount - 1);
    }
    case "linear": {
      return delay * attemptCount;
    }
    case "constant":
    default: {
      return delay;
    }
  }
}
