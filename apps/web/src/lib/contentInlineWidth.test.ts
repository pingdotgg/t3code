import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { contentInlineWidth } from "./contentInlineWidth";

function box(clientWidth: number, style: Record<string, string>) {
  vi.stubGlobal("getComputedStyle", () => style);
  return contentInlineWidth({ clientWidth } as unknown as HTMLElement);
}

afterEach(() => vi.unstubAllGlobals());

describe("contentInlineWidth", () => {
  it("drops both inline sides of the padding clientWidth counts as room", () => {
    // Unequal sides: reading only one of them, or the physical props, answers
    // for less than the full padding.
    expect(box(724, { paddingInlineStart: "4px", paddingInlineEnd: "8px" })).toBe(712);
  });

  it("treats an unresolvable padding as none instead of answering NaN", () => {
    // Computed padding is px in browsers, but a missing or keyword value must
    // not poison a fit decision into "nothing fits".
    expect(box(100, { paddingInlineStart: "auto", paddingInlineEnd: "8px" })).toBe(92);
    expect(box(100, {})).toBe(100);
  });

  it("goes negative rather than clipping a box whose padding exceeds it", () => {
    // Callers compare against a needed width, so a squeezed box has to read as
    // short of room.
    expect(box(10, { paddingInlineStart: "8px", paddingInlineEnd: "8px" })).toBe(-6);
  });
});
