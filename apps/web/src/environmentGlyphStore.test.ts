import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { normalizeEnvironmentGlyph, useEnvironmentGlyphStore } from "./environmentGlyphStore";

const epsilonId = EnvironmentId.make("environment-epsilon");
const alphaId = EnvironmentId.make("environment-alpha");

describe("environment glyph store", () => {
  beforeEach(() => {
    useEnvironmentGlyphStore.setState({ byId: {} });
  });

  it("keeps one complete grapheme", () => {
    expect(normalizeEnvironmentGlyph("  π  ")).toBe("π");
    expect(normalizeEnvironmentGlyph("αβγδε")).toBe("α");
    expect(normalizeEnvironmentGlyph("e\u0301xyz")).toBe("e\u0301");
    expect(normalizeEnvironmentGlyph("👩🏽‍💻x")).toBe("👩🏽‍💻");
    expect(normalizeEnvironmentGlyph("   ")).toBeNull();
  });

  it("stores and clears each environment independently", () => {
    const store = useEnvironmentGlyphStore.getState();
    store.setGlyph(epsilonId, " ε ");
    store.setGlyph(alphaId, "α");
    expect(useEnvironmentGlyphStore.getState().byId).toEqual({
      [epsilonId]: "ε",
      [alphaId]: "α",
    });
    store.setGlyph(epsilonId, "");
    expect(useEnvironmentGlyphStore.getState().byId).toEqual({ [alphaId]: "α" });
  });

  it("avoids no-op updates", () => {
    const store = useEnvironmentGlyphStore.getState();
    store.setGlyph(epsilonId, "ε");
    const previous = useEnvironmentGlyphStore.getState();
    store.setGlyph(epsilonId, " ε ");
    expect(useEnvironmentGlyphStore.getState()).toBe(previous);
  });
});
