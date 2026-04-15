import { describe, expect, it } from "vitest";

import {
  hasTurboModuleProxy,
  resolveReviewHighlighterEngine,
  resolveReviewHighlighterEnginePreference,
} from "./reviewHighlighterEngine";

describe("resolveReviewHighlighterEnginePreference", () => {
  it("defaults invalid values to auto", () => {
    expect(resolveReviewHighlighterEnginePreference(undefined)).toBe("auto");
    expect(resolveReviewHighlighterEnginePreference("bogus")).toBe("auto");
  });

  it("accepts supported values", () => {
    expect(resolveReviewHighlighterEnginePreference("auto")).toBe("auto");
    expect(resolveReviewHighlighterEnginePreference("javascript")).toBe("javascript");
    expect(resolveReviewHighlighterEnginePreference("native")).toBe("native");
  });
});

describe("resolveReviewHighlighterEngine", () => {
  it("uses javascript when explicitly requested", () => {
    expect(resolveReviewHighlighterEngine("javascript", true)).toBe("javascript");
    expect(resolveReviewHighlighterEngine("javascript", false)).toBe("javascript");
  });

  it("uses native when available for auto or native preference", () => {
    expect(resolveReviewHighlighterEngine("auto", true)).toBe("native");
    expect(resolveReviewHighlighterEngine("native", true)).toBe("native");
  });

  it("falls back to javascript when native is unavailable", () => {
    expect(resolveReviewHighlighterEngine("auto", false)).toBe("javascript");
    expect(resolveReviewHighlighterEngine("native", false)).toBe("javascript");
  });
});

describe("hasTurboModuleProxy", () => {
  it("returns false outside a native runtime", () => {
    expect(hasTurboModuleProxy()).toBe(false);
  });
});
