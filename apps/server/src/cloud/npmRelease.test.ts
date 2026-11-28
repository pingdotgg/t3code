import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import * as NpmRelease from "./npmRelease.ts";

it.effect.each(["latest", "nightly", "1.0.0", "0.1.5-nightly.20261030.1"])(
  "refuses npm release lookups for %s until Hyakki publishes releases",
  (spec) =>
    Effect.gen(function* () {
      const service = yield* NpmRelease.make();
      const found = yield* service.get({ spec }).pipe(Effect.result);
      expect(Result.isFailure(found)).toBe(true);
      if (Result.isFailure(found)) {
        expect(found.failure).toBeInstanceOf(ServerNpmReleaseError);
        expect(found.failure.reason).toBe(
          "Hyakki does not publish its server yet; install it on that machine from source.",
        );
      }
    }),
);

it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
  "rejects invalid release specs: %s",
  (spec) =>
    Effect.gen(function* () {
      const service = yield* NpmRelease.make();
      const found = yield* service.get({ spec }).pipe(Effect.result);
      expect(Result.isFailure(found)).toBe(true);
      if (Result.isFailure(found)) {
        expect(found.failure).toBeInstanceOf(ServerNpmReleaseError);
        expect(found.failure.reason).toBe("Invalid release version or track.");
      }
    }),
);
