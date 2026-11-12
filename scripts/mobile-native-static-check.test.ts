import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { requireKotlinTools } from "./mobile-native-static-check.ts";

it.effect("allows Kotlin checks when ktlint and detekt are on PATH", () =>
  requireKotlinTools({ ktlint: true, detekt: true }),
);

it.effect("fails when ktlint or detekt is missing instead of skipping", () =>
  Effect.gen(function* () {
    const ktlintError = yield* requireKotlinTools({ ktlint: false, detekt: true }).pipe(
      Effect.flip,
    );
    if (ktlintError._tag !== "NativeStaticCheckMissingToolError") {
      return assert.fail(`Unexpected error: ${ktlintError._tag}`);
    }
    assert.deepEqual(ktlintError.commands, ["ktlint"]);

    const bothError = yield* requireKotlinTools({ ktlint: false, detekt: false }).pipe(Effect.flip);
    if (bothError._tag !== "NativeStaticCheckMissingToolError") {
      return assert.fail(`Unexpected error: ${bothError._tag}`);
    }
    assert.deepEqual(bothError.commands, ["ktlint", "detekt"]);
  }),
);
