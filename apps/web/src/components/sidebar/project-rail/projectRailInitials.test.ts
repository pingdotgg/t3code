import { describe, expect, it } from "vite-plus/test";

import { resolveProjectInitials } from "./projectRailInitials";

describe("resolveProjectInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(resolveProjectInitials("Waterfruit Puzzle")).toBe("WP");
    expect(resolveProjectInitials("T3 Code")).toBe("T3");
  });

  it("treats separators as word boundaries", () => {
    expect(resolveProjectInitials("orange-cli")).toBe("OC");
    expect(resolveProjectInitials("my_app")).toBe("MA");
    expect(resolveProjectInitials("scripts/build-tools")).toBe("SB");
  });

  it("splits camelCase and digit boundaries", () => {
    expect(resolveProjectInitials("webApp")).toBe("WA");
    expect(resolveProjectInitials("t3code")).toBe("T3");
  });

  it("falls back to the first two characters of a single word", () => {
    expect(resolveProjectInitials("monocode")).toBe("MO");
    expect(resolveProjectInitials("x")).toBe("X");
  });

  it("keeps astral characters whole", () => {
    // Indexing by code unit would split the surrogate pair and render a
    // replacement glyph instead of the emoji.
    expect(resolveProjectInitials("🚀 Rocket")).toBe("🚀R");
    expect(resolveProjectInitials("🚀🛰️")).toBe("🚀🛰");
  });

  it("stays renderable for an empty name", () => {
    expect(resolveProjectInitials("")).toBe("?");
    expect(resolveProjectInitials("   ")).toBe("?");
  });
});
