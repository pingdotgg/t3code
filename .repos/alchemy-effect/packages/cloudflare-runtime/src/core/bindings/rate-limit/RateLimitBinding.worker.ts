// Emulated Ratelimit Binding
import type { RateLimitProps } from "./RateLimitProps.shared.ts";

// options for Ratelimit
//   (should be kept in sync with https://bitbucket.cfdata.org/projects/EW/repos/edgeworker/browse/src/edgeworker/internal-api/ratelimit.capnp)
const RATE_LIMIT_OPTION_KEYS = ["key", "limit", "period"];
const RATE_LIMIT_PERIOD_VALUES = [10, 60];

// create a new Ratelimit
export default function makeBinding(env: { PROPS: RateLimitProps }) {
  return new RateLimitBinding(env.PROPS);
}

interface Bucket {
  count: number;
  resetAt: number;
}

class RateLimitBinding implements RateLimit {
  // Per-key fixed windows anchored at each key's first request. A single
  // wall-clock-aligned epoch (`floor(now / period)`) is wrong twice over:
  // an absolute period boundary crossing between requests wipes the counter
  // mid-sequence, and a shared epoch lets a call with one period clear the
  // buckets of every other key/period.
  buckets: Map<string, Bucket>;

  constructor(readonly config: RateLimitProps) {
    this.buckets = new Map<string, Bucket>();
  }

  // method that counts and checks against the limit in in-memory buckets
  async limit(options: RateLimitOptions): Promise<RateLimitOutcome> {
    // validate options input
    validate(
      typeof options === "object" && options !== null,
      "invalid rate limit options",
    );
    const invalidProps = Object.keys(options ?? {}).filter(
      (key) => !RATE_LIMIT_OPTION_KEYS.includes(key),
    );
    validate(
      invalidProps.length == 0,
      `bad rate limit options: [${invalidProps.join(",")}]`,
    );
    const {
      key = "",
      limit = this.config.simple.limit,
      period = this.config.simple.period,
    } = options as RateLimitOptions & Partial<RateLimitProps["simple"]>;
    validate(typeof key === "string", `invalid key: ${key}`);
    validate(typeof limit === "number", `limit must be a number: ${limit}`);
    validate(typeof period === "number", `period must be a number: ${period}`);
    validate(
      RATE_LIMIT_PERIOD_VALUES.includes(period),
      `unsupported period: ${period}`,
    );

    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined || now >= bucket.resetAt) {
      // drop other expired windows while we're here so the map stays bounded
      for (const [k, b] of this.buckets) {
        if (now >= b.resetAt) {
          this.buckets.delete(k);
        }
      }
      bucket = { count: 0, resetAt: now + period * 1000 };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= limit) {
      return {
        success: false,
      };
    }
    bucket.count += 1;
    return {
      success: true,
    };
  }
}

function validate(test: boolean, message: string): asserts test {
  if (!test) {
    throw new Error(message);
  }
}
