import { describe, expect, it } from "vite-plus/test";

import { isPasteAsTextShortcut, pastedTextDisposition } from "./textPaste.ts";

describe("isPasteAsTextShortcut", () => {
  it("accepts the V key on non-Latin layouts but follows the letter on Latin ones", () => {
    const chord = { metaKey: false, ctrlKey: true, shiftKey: true, altKey: false };
    expect(isPasteAsTextShortcut({ ...chord, key: "М", code: "KeyV" }, false)).toBe(true);
    expect(isPasteAsTextShortcut({ ...chord, key: "k", code: "KeyV" }, false)).toBe(false);
    expect(isPasteAsTextShortcut({ ...chord, key: "V", code: "Period" }, false)).toBe(true);
  });
});

describe("pastedTextDisposition", () => {
  it("folds a paste that would push the inline prompt past the threshold", () => {
    const kb20 = "x".repeat(20 * 1024);
    const prompt = { value: kb20, selection: { start: kb20.length, end: kb20.length } };
    expect(pastedTextDisposition({ text: kb20, canAttach: true, prompt })).toBe("attachment");
  });
});
