import { assert, it } from "@effect/vitest";

import { MIRROR_EXTRA_ENV_PATTERNS, MIRROR_INCLUDE_EXCLUDE_PATHSPECS } from "./mirrorInclude.ts";

it("MIRROR_EXTRA_ENV_PATTERNS covers the common env-file patterns at any depth", () => {
  assert.deepStrictEqual(MIRROR_EXTRA_ENV_PATTERNS, [
    ":(glob)**/.env",
    ":(glob)**/.env.local",
    ":(glob)**/.env.*.local",
  ]);
  assert.deepStrictEqual(MIRROR_INCLUDE_EXCLUDE_PATHSPECS, [":(glob,exclude)**/node_modules/**"]);
});
