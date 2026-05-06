import { describe, expect, it } from "vitest";

import { withCustomUserInputOption } from "./userInputOptions.ts";

describe("withCustomUserInputOption", () => {
  it("preserves preset options without appending Other", () => {
    expect(
      withCustomUserInputOption([
        { label: "One", description: "First" },
        { label: "Two", description: "Second" },
        { label: "Three", description: "Third" },
        { label: "Four", description: "Fourth" },
      ]),
    ).toEqual([
      { label: "One", description: "First" },
      { label: "Two", description: "Second" },
      { label: "Three", description: "Third" },
      { label: "Four", description: "Fourth" },
    ]);
  });

  it("drops provider-supplied Other options", () => {
    expect(
      withCustomUserInputOption([
        { label: "Other", description: "Write one" },
        { label: "One", description: "First" },
      ]),
    ).toEqual([{ label: "One", description: "First" }]);
  });
});
