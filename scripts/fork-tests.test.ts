import { assert, describe, it } from "@effect/vitest";

import { readKnownFailures, skipPattern } from "./fork-tests.ts";

describe("skipPattern", () => {
  it("matches every test name except the known failures", () => {
    const pattern = new RegExp(
      skipPattern([{ file: "a.test.ts", test: "reads (a) file.", reason: "macOS" }]),
    );
    assert.isFalse(pattern.test("suite reads (a) file."));
    assert.isTrue(pattern.test("suite reads a file"));
  });
});

describe("readKnownFailures", () => {
  it("rejects an entry without a reason", () => {
    assert.throws(() => readKnownFailures('[{"file":"a.test.ts","test":"x"}]'));
  });
});
