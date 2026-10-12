import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/**
 * A token bucket on the Effect clock: `burst` takes at once, then one more per
 * `refillMillis`. `take` succeeds with whether a token was available. It reads
 * wall time, so a backward clock step delays refills until the clock catches
 * up; the burst still bounds what a plugin can send.
 */
export const makeTokenBucket = (options: {
  readonly burst: number;
  readonly refillMillis: number;
}) => {
  let tokens = options.burst;
  let refilledAt: number | undefined;
  return {
    take: Effect.map(Clock.currentTimeMillis, (now) => {
      if (refilledAt !== undefined) {
        const earned = Math.floor((now - refilledAt) / options.refillMillis);
        if (earned > 0) {
          tokens = Math.min(options.burst, tokens + earned);
          refilledAt = tokens === options.burst ? now : refilledAt + earned * options.refillMillis;
        }
      }
      if (tokens === 0) return false;
      if (tokens === options.burst) refilledAt = now;
      tokens--;
      return true;
    }),
  };
};
