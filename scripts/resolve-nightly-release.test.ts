import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  resolveNightlyBaseVersion,
  resolveNightlyReleaseMetadata,
  resolveNightlyTargetVersion,
} from "./resolve-nightly-release.ts";

it("strips prerelease and build metadata when deriving the nightly base version", () => {
  assert.equal(resolveNightlyBaseVersion("0.0.17"), "0.0.17");
  assert.equal(resolveNightlyBaseVersion("9.9.9-smoke.0"), "9.9.9");
  assert.equal(resolveNightlyBaseVersion("1.2.3-beta.4+build.9"), "1.2.3");
});

it.effect("bumps the patch version before deriving nightly prerelease versions", () =>
  Effect.gen(function* () {
    assert.equal(yield* resolveNightlyTargetVersion("0.0.17"), "0.0.18");
    assert.equal(yield* resolveNightlyTargetVersion("9.9.9-smoke.0"), "9.9.10");
    assert.equal(yield* resolveNightlyTargetVersion("1.2.3-beta.4+build.9"), "1.2.4");
  }),
);

it.effect("reports the invalid desktop package version", () =>
  Effect.gen(function* () {
    const error = yield* resolveNightlyTargetVersion("nightly").pipe(Effect.flip);

    assert.equal(error._tag, "InvalidDesktopPackageVersionError");
    assert.equal(error.version, "nightly");
    assert.equal(error.message, "Invalid desktop package version 'nightly'.");
  }),
);

it("derives nightly metadata including the short commit sha in the release name", () => {
  assert.deepStrictEqual(
    resolveNightlyReleaseMetadata("9.9.10", "20260413", 321, "abcdef1234567890"),
    {
      baseVersion: "9.9.10",
      version: "9.9.10-nightly.20260413.321",
      tag: "v9.9.10-nightly.20260413.321",
      name: "T3 Code Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
      shortSha: "abcdef123456",
    },
  );
});
