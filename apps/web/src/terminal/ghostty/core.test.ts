import { describe, expect, it } from "vite-plus/test";

import { ghosttyCellText } from "./core";

function codepointView(codepoints: ReadonlyArray<number>): DataView {
  const view = new DataView(new ArrayBuffer(codepoints.length * 4));
  codepoints.forEach((codepoint, index) => view.setUint32(index * 4, codepoint, true));
  return view;
}

describe("ghosttyCellText", () => {
  it("converts oversized grapheme clusters without hitting engine spread limits", () => {
    // A program printing one base character followed by a huge run of
    // combining marks packs the whole cluster into one cell; spreading that
    // many arguments into String.fromCodePoint once overflows the call stack.
    const graphemeLength = 130_000;
    const view = new DataView(new ArrayBuffer(graphemeLength * 4));
    for (let index = 0; index < graphemeLength; index += 1) {
      view.setUint32(index * 4, index === 0 ? "a".codePointAt(0)! : 0x301, true);
    }
    const text = ghosttyCellText(view, graphemeLength);
    expect(text.length).toBe(graphemeLength);
    expect(text.codePointAt(0)).toBe("a".codePointAt(0));
    expect(text.codePointAt(1)).toBe(0x301);
    expect(text.codePointAt(graphemeLength - 1)).toBe(0x301);
  });

  it("converts small clusters including astral codepoints", () => {
    const text = ghosttyCellText(codepointView([0x1f642, 0x20e3]), 2);
    expect([...text]).toEqual(["\u{1F642}", "\u{20E3}"]);
  });

  it("returns an empty string for empty cells", () => {
    expect(ghosttyCellText(codepointView([]), 0)).toBe("");
  });
});
