import { describe, expect, it } from "@effect/vitest";

import { parseRequiredNumber } from "./agentSettings.logic";

describe("mobile agent settings numeric fields", () => {
  it("trims input before parsing it once", () => {
    expect(parseRequiredNumber("  12.5  ", "Limit")).toBe(12.5);
  });

  it("rejects blank and non-finite values", () => {
    expect(() => parseRequiredNumber("   ", "Limit")).toThrow("Limit is required.");
    expect(() => parseRequiredNumber("NaN", "Limit")).toThrow("Limit must be a finite number.");
    expect(() => parseRequiredNumber("Infinity", "Limit")).toThrow(
      "Limit must be a finite number.",
    );
    expect(() => parseRequiredNumber("-Infinity", "Limit")).toThrow(
      "Limit must be a finite number.",
    );
  });
});
