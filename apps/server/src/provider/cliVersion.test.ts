import { assert, describe, it } from "@effect/vitest";

import { compareCliVersions, normalizeCliVersion } from "./cliVersion.ts";

describe("cliVersion", () => {
  it("normalizes versions with a missing patch segment", () => {
    assert.strictEqual(normalizeCliVersion("2.1"), "2.1.0");
  });

  it("compares prerelease versions before stable versions", () => {
    assert.isTrue(compareCliVersions("2.1.111-beta.1", "2.1.111") < 0);
  });

  it("rejects malformed numeric segments", () => {
    assert.isTrue(compareCliVersions("1.2.3abc", "1.2.10") > 0);
  });
});
