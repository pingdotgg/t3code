import { sanitizeLockKey, withLock } from "@/Auth/Lock.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("sanitizeLockKey", () => {
  it("leaves conventional keys untouched", () => {
    expect(sanitizeLockKey("default-Cloudflare")).toBe("default-Cloudflare");
    expect(sanitizeLockKey("my_profile.v2-AWS")).toBe("my_profile.v2-AWS");
  });

  it("neutralises unexpanded shell placeholders", () => {
    // Seen verbatim in production: EINVAL mkdir
    // '...\${ALCHEMY_PROFILE:-default}-Cloudflare.lock.lock' on Windows,
    // where `:`/`$`/`{`/`}` are invalid in file names.
    const sanitized = sanitizeLockKey("${ALCHEMY_PROFILE:-default}-Cloudflare");
    expect(sanitized).toBe("__ALCHEMY_PROFILE_-default_-Cloudflare");
    expect(sanitized).not.toMatch(/[<>:"/\\|?*${}]/);
  });

  it("replaces path separators so keys cannot escape the lock dir", () => {
    expect(sanitizeLockKey("../../etc/passwd")).toBe(".._.._etc_passwd");
  });
});

describe("withLock", () => {
  it.live(
    "acquires and releases a lock whose key contains characters invalid in file names",
    () =>
      Effect.gen(function* () {
        // Regression for the production EINVAL: this key is unusable as a
        // raw Windows file name without sanitisation.
        const result = yield* withLock(
          "${ALCHEMY_PROFILE:-default}-LockTest",
          Effect.succeed("ran"),
        );
        expect(result).toBe("ran");
      }),
  );

  it.live("serialises same-key critical sections in-process", () =>
    Effect.gen(function* () {
      const order: number[] = [];
      const critical = (i: number) =>
        withLock(
          "lock-test-serialise",
          Effect.gen(function* () {
            order.push(i);
            yield* Effect.sleep("50 millis");
            order.push(i);
          }),
        );
      yield* Effect.all([critical(1), critical(2)], {
        concurrency: "unbounded",
      });
      // Each critical section's two entries must be adjacent — no
      // interleaving between holders.
      expect(order.slice(0, 2)).toEqual([order[0], order[0]]);
      expect(order.slice(2)).toEqual([order[2], order[2]]);
    }),
  );
});
