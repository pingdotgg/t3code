import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_COLOR_OPTIONS,
  resolveProjectColorCss,
  resolveProjectGroupColorCss,
} from "./projectColors";

describe("resolveProjectColorCss", () => {
  it("maps known palette tokens to their css color", () => {
    for (const option of PROJECT_COLOR_OPTIONS) {
      expect(resolveProjectColorCss(option.value)).toBe(option.cssColor);
    }
  });

  it("returns null for missing or unknown tokens", () => {
    expect(resolveProjectColorCss(null)).toBeNull();
    expect(resolveProjectColorCss(undefined)).toBeNull();
    expect(resolveProjectColorCss("")).toBeNull();
    expect(resolveProjectColorCss("not-a-color")).toBeNull();
  });
});

describe("resolveProjectGroupColorCss", () => {
  it("uses the first member with a recognized color", () => {
    expect(
      resolveProjectGroupColorCss([
        { color: null },
        { color: "unknown-token" },
        { color: "blue" },
        { color: "red" },
      ]),
    ).toBe("#3b82f6");
  });

  it("returns null when no member has a recognized color", () => {
    expect(resolveProjectGroupColorCss([])).toBeNull();
    expect(resolveProjectGroupColorCss([{ color: null }, {}])).toBeNull();
  });
});
