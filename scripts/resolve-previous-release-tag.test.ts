import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolvePreviousReleaseTag } from "./resolve-previous-release-tag.ts";

it.effect("selects the latest earlier stable tag and ignores nightlies", () =>
  Effect.gen(function* () {
    const previous = yield* resolvePreviousReleaseTag("stable", "v1.2.0", [
      "v1.1.0",
      "v1.1.1-nightly.20260619.1",
      "v1.1.2",
      "v1.2.0",
    ]);

    assert.equal(previous, "v1.1.2");
  }),
);

it.effect("accepts legacy nightly tags when selecting the previous nightly", () =>
  Effect.gen(function* () {
    const previous = yield* resolvePreviousReleaseTag("nightly", "v1.2.0-nightly.20260620.2", [
      "nightly-v1.2.0-nightly.20260620.1",
      "v1.1.0-nightly.20260619.9",
    ]);

    assert.equal(previous, "nightly-v1.2.0-nightly.20260620.1");
  }),
);

it.effect("reports the invalid tag with its release channel", () =>
  Effect.gen(function* () {
    const error = yield* resolvePreviousReleaseTag("nightly", "v1.2.0", []).pipe(Effect.flip);

    assert.equal(error._tag, "InvalidReleaseTagError");
    assert.equal(error.channel, "nightly");
    assert.equal(error.currentTag, "v1.2.0");
    assert.equal(error.message, "Invalid nightly release tag 'v1.2.0'.");
  }),
);
