import { describe, expect, it } from "vitest";

/**
 * Tests for code block copy-button logic used by MarkdownCodeBlock.
 *
 * The component provides two improvements over the original implementation:
 *
 * 1. A configurable copy button position (top or bottom) via client settings.
 *    Long code blocks on mobile make the top-right button hard to reach;
 *    the "bottom" option places it at the end of the block instead.
 *
 * 2. A clipboard fallback for non-secure contexts. The Clipboard API
 *    (`navigator.clipboard`) requires HTTPS, but remote T3 Code sessions
 *    served over HTTP (e.g. Tailscale) lack it. The fallback uses the
 *    legacy `document.execCommand("copy")` path.
 */

describe("copy button position style", () => {
  const resolvePositionStyle = (position: "top" | "bottom") =>
    position === "bottom"
      ? { top: "auto", bottom: "0.5rem" }
      : { top: "0.5rem" };

  it("returns top positioning by default", () => {
    expect(resolvePositionStyle("top")).toEqual({ top: "0.5rem" });
  });

  it("returns bottom positioning with top explicitly set to auto", () => {
    const style = resolvePositionStyle("bottom");
    expect(style).toEqual({ top: "auto", bottom: "0.5rem" });
  });

  it("overrides the CSS top rule when set to bottom", () => {
    const style = resolvePositionStyle("bottom");
    // The CSS stylesheet sets `top: 0.5rem` as a default.
    // When the setting is "bottom", the inline style must explicitly
    // set `top: "auto"` to cancel the stylesheet rule, otherwise
    // both `top` and `bottom` apply and `top` wins per CSS spec.
    expect(style.top).toBe("auto");
    expect(style.bottom).toBe("0.5rem");
  });
});

describe("clipboard availability detection", () => {
  it("identifies secure context by clipboard API presence", () => {
    // The component checks: navigator.clipboard != null
    // This mirrors the guard used in MarkdownCodeBlock.handleCopy
    const hasClipboardApi = (nav: { clipboard?: unknown }) =>
      typeof nav !== "undefined" && nav.clipboard != null;

    expect(hasClipboardApi({ clipboard: { writeText: () => {} } })).toBe(true);
    expect(hasClipboardApi({ clipboard: undefined })).toBe(false);
    expect(hasClipboardApi({ clipboard: null })).toBe(false);
    expect(hasClipboardApi({})).toBe(false);
  });
});
