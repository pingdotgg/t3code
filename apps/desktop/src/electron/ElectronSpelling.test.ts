import { assert, describe, it } from "@effect/vitest";

import { parsePlatformSuggestions } from "./ElectronSpelling.ts";

describe("ElectronSpelling", () => {
  it("normalizes platform suggestions", () => {
    assert.deepEqual(
      parsePlatformSuggestions('["texting", "testing", 3, null, " ", "testing", " toting "]'),
      ["texting", "testing", "toting"],
    );
  });

  it("rejects malformed platform output", () => {
    assert.deepEqual(parsePlatformSuggestions(""), []);
    assert.deepEqual(parsePlatformSuggestions('{"suggestion":"testing"}'), []);
  });

  it("caps the number of suggestions", () => {
    const output = JSON.stringify(Array.from({ length: 30 }, (_, index) => `word${index}`));
    assert.equal(parsePlatformSuggestions(output).length, 10);
  });
});
