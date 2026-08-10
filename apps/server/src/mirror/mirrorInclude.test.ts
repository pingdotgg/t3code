import { assert, it } from "@effect/vitest";

import { MIRROR_EXTRA_ENV_PATTERNS } from "./mirrorInclude.ts";

it("MIRROR_EXTRA_ENV_PATTERNS covers the common env-file patterns", () => {
  assert.deepStrictEqual(MIRROR_EXTRA_ENV_PATTERNS, [".env", ".env.local", ".env.*.local"]);
});
