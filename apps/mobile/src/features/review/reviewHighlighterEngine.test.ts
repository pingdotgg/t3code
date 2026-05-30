import { describe, expect, it } from "vitest";

import {
  resolveReviewHighlighterEngine,
  resolveReviewHighlighterEnginePreference,
} from "./reviewHighlighterEngine";

describe("resolveReviewHighlighterEnginePreference", () => {
  it("defaults invalid values to native", () => {
    expect(resolveReviewHighlighterEnginePreference(undefined)).toBe("native");
    expect(resolveReviewHighlighterEnginePreference("bogus")).toBe("native");
  });

  it("accepts supported values", () => {
    expect(resolveReviewHighlighterEnginePreference("javascript")).toBe("javascript");
    expect(resolveReviewHighlighterEnginePreference("js")).toBe("javascript");
    expect(resolveReviewHighlighterEnginePreference("native")).toBe("native");
  });
});

describe("resolveReviewHighlighterEngine", () => {
  it("uses javascript when explicitly requested", () => {
    expect(resolveReviewHighlighterEngine("javascript", true)).toBe("javascript");
    expect(resolveReviewHighlighterEngine("javascript", false)).toBe("javascript");
  });

  it("uses native when available for native preference", () => {
    expect(resolveReviewHighlighterEngine("native", true)).toBe("native");
  });

  it("falls back to javascript when native is unavailable", () => {
    expect(resolveReviewHighlighterEngine("native", false)).toBe("javascript");
  });
});
