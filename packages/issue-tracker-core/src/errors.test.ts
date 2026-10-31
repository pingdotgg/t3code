import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  NotConnected,
  NotFound,
  RateLimited,
  Rejected,
  toLinearError,
  Unauthorized,
  Unavailable,
} from "./errors.ts";
import { apiKeyAuth } from "./IssueTrackerAuth.ts";

describe("toLinearError", () => {
  it("maps every tracker error to a wire reason with fixed text", () => {
    assert.strictEqual(toLinearError(new NotConnected()).reason, "not_connected");
    assert.strictEqual(toLinearError(new Unauthorized()).reason, "unauthorized");
    assert.strictEqual(
      toLinearError(new Unavailable({ message: "Couldn't reach Linear." })).reason,
      "unavailable",
    );
    assert.strictEqual(toLinearError(new NotFound({ message: "gone" })).reason, "not_found");
    assert.strictEqual(toLinearError(new Rejected({ message: "no" })).reason, "invalid_input");
    const limited = toLinearError(new RateLimited({ retryAfterSeconds: 12.2 }));
    assert.strictEqual(limited.reason, "rate_limited");
    assert.strictEqual(limited.retryAfterSeconds, 13);
  });
});

describe("apiKeyAuth", () => {
  it.effect("yields the key as-is and refuses an empty one", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* apiKeyAuth(Effect.succeed("lin_api_x")).authorizationHeader,
        "lin_api_x",
      );
      const error = yield* Effect.flip(apiKeyAuth(Effect.succeed("")).authorizationHeader);
      assert.strictEqual(error._tag, "IssueTrackerNotConnected");
    }),
  );
});
