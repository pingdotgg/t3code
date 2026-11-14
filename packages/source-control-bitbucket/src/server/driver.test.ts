import { assert, describe, it } from "@effect/vitest";

import { BitbucketResponseBodyReadError, BitbucketResponseError } from "./BitbucketApi.ts";
import { driver } from "./driver.ts";

describe("rateLimitRefusal", () => {
  it("recognizes a 429, including one whose body was cut off", () => {
    const refusal = (error: unknown) => driver.rateLimitRefusal?.(error);
    assert.deepStrictEqual(
      refusal(
        new BitbucketResponseBodyReadError({
          operation: "listPullRequests",
          status: 429,
          retryAt: 1_000,
          cause: new Error("truncated"),
        }),
      ),
      { retryAt: 1_000 },
    );
    assert.deepStrictEqual(
      refusal(
        new BitbucketResponseError({
          operation: "listPullRequests",
          status: 429,
          responseBodyLength: 0,
        }),
      ),
      {},
    );
    assert.isUndefined(
      refusal(
        new BitbucketResponseError({
          operation: "listPullRequests",
          status: 500,
          responseBodyLength: 0,
        }),
      ),
    );
  });
});
