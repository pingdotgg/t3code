import { describe, expect, it } from "vitest";

import { shouldUseCompactComposerFooter } from "./composerFooterLayout";

describe("shouldUseCompactComposerFooter", () => {
  it("stays expanded without a measured width", () => {
    expect(shouldUseCompactComposerFooter(null)).toBe(false);
  });

  it("switches to compact mode below the breakpoint", () => {
    expect(shouldUseCompactComposerFooter(619)).toBe(true);
  });

  it("stays expanded at and above the breakpoint", () => {
    expect(shouldUseCompactComposerFooter(620)).toBe(false);
    expect(shouldUseCompactComposerFooter(668)).toBe(false);
  });

  it("uses a higher breakpoint for wide action states", () => {
    expect(shouldUseCompactComposerFooter(719, { hasWideActions: true })).toBe(true);
    expect(shouldUseCompactComposerFooter(720, { hasWideActions: true })).toBe(false);
  });
});
