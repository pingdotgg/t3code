import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { contentInlineWidth } from "./contentInlineWidth";

function box(clientWidth: number, style: Record<string, string>) {
  vi.stubGlobal("getComputedStyle", () => style);
  return contentInlineWidth({ clientWidth } as unknown as HTMLElement);
}

afterEach(() => vi.unstubAllGlobals());

describe("contentInlineWidth", () => {
  it("drops the inline padding clientWidth counts as room", () => {
    expect(box(724, { paddingInlineStart: "4px", paddingInlineEnd: "8px" })).toBe(712);
  });

  it("keeps the whole width when the box has no inline padding", () => {
    expect(box(724, { paddingInlineStart: "0px", paddingInlineEnd: "0px" })).toBe(724);
  });

  it("reads the logical sides so padding-only-one-side still counts", () => {
    expect(box(100, { paddingInlineStart: "12px", paddingInlineEnd: "0px" })).toBe(88);
    expect(box(100, { paddingInlineStart: "0px", paddingInlineEnd: "12px" })).toBe(88);
  });

  it("treats an unresolvable padding as none instead of answering NaN", () => {
    // Computed padding is px in browsers, but a missing or keyword value must
    // not poison a fit decision into "nothing fits".
    expect(box(100, { paddingInlineStart: "auto", paddingInlineEnd: "8px" })).toBe(92);
    expect(box(100, {})).toBe(100);
  });

  it("can go negative when padding exceeds the border-box content", () => {
    // Callers compare against a needed width, so a squeezed box must read as
    // having no usable room rather than a clipped zero.
    expect(box(10, { paddingInlineStart: "8px", paddingInlineEnd: "8px" })).toBe(-6);
  });
});
