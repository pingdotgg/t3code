import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { measureComposerMultilinePrompt } from "./useComposerMultilinePrompt";

function measure(input: { width: number; height: number; resting?: boolean; hidden?: boolean }) {
  const editor = { clientWidth: input.hidden ? 0 : input.resting ? 400 : 500 };
  const body = { clientWidth: 532, querySelector: () => editor };
  vi.stubGlobal("getComputedStyle", (element: unknown) =>
    element === body
      ? { paddingLeft: "16px", paddingRight: "16px" }
      : { lineHeight: input.resting ? "32px" : "22.75px" },
  );
  vi.stubGlobal("document", {
    createRange: () => ({
      selectNodeContents() {},
      getBoundingClientRect: () => ({ width: input.width, height: input.height }),
    }),
  });
  return measureComposerMultilinePrompt(body as unknown as HTMLElement);
}

afterEach(() => vi.unstubAllGlobals());

describe("composer prompt line measurement", () => {
  it("allows a single line even though the editor has a larger minimum height", () => {
    expect(measure({ width: 500, height: 22.75 })).toBe(false);
  });

  it("keeps soft-wrapped lines expanded", () => {
    expect(measure({ width: 500, height: 45.5 })).toBe(true);
  });

  it("recognizes a long restored draft while the resting row is unwrapped", () => {
    expect(measure({ width: 700, height: 32, resting: true })).toBe(true);
  });

  it("uses the expanded width so inline actions cannot cause a collapse loop", () => {
    expect(measure({ width: 450, height: 32, resting: true })).toBe(false);
    expect(measure({ width: 500, height: 22.75 })).toBe(false);
  });

  it("allows collapse again after deleting the second line", () => {
    expect(measure({ width: 500, height: 45.5 })).toBe(true);
    expect(measure({ width: 500, height: 22.75 })).toBe(false);
  });

  it("retains the previous measurement when the editor is hidden", () => {
    expect(measure({ width: 0, height: 0, hidden: true })).toBeNull();
  });
});
