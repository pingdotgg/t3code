import { validateAccountId } from "@/Cloudflare/Auth/AuthProvider.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

/**
 * Production traces showed 242 distinct users hitting
 * `InvalidRoute: Could not route to /accounts/workers/scripts/...`
 * because an empty account ID was interpolated into the API path, plus
 * placeholder values ("-", "dummy", "test", "mock") producing the same
 * class of failure. `validateAccountId` turns all of those into a
 * typed `AuthError` with an actionable message before any API call.
 */
describe("validateAccountId", () => {
  const valid = "2b29022c8dbd18353220a2f637eeba33";

  it.effect("accepts a valid 32-hex account ID", () =>
    Effect.gen(function* () {
      const id = yield* validateAccountId(valid, "test");
      expect(id).toBe(valid);
    }),
  );

  it.effect("trims whitespace and lowercases", () =>
    Effect.gen(function* () {
      const id = yield* validateAccountId(`  ${valid.toUpperCase()}  `, "test");
      expect(id).toBe(valid);
    }),
  );

  it.effect("rejects undefined with an actionable message", () =>
    Effect.gen(function* () {
      const error = yield* validateAccountId(undefined, "test").pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("missing");
      expect(error.message).toContain("CLOUDFLARE_ACCOUNT_ID");
    }),
  );

  it.effect("rejects the empty string", () =>
    Effect.gen(function* () {
      const error = yield* validateAccountId("", "test").pipe(Effect.flip);
      expect(error.message).toContain("missing");
    }),
  );

  it.effect("rejects whitespace-only values", () =>
    Effect.gen(function* () {
      const error = yield* validateAccountId("   ", "test").pipe(Effect.flip);
      expect(error.message).toContain("missing");
    }),
  );

  for (const placeholder of ["-", "dummy", "test", "mock", "abc123"]) {
    it.effect(`rejects the placeholder value '${placeholder}'`, () =>
      Effect.gen(function* () {
        const error = yield* validateAccountId(placeholder, "test").pipe(
          Effect.flip,
        );
        expect(error._tag).toBe("AuthError");
        expect(error.message).toContain(placeholder);
        expect(error.message).toContain("32 hex characters");
      }),
    );
  }

  it.effect("names the source of the bad value in the message", () =>
    Effect.gen(function* () {
      const error = yield* validateAccountId(
        "dummy",
        "stored for profile 'ci'",
      ).pipe(Effect.flip);
      expect(error.message).toContain("stored for profile 'ci'");
    }),
  );
});
