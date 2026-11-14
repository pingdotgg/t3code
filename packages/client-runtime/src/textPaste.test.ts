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
  const kb = (size: number) => "x".repeat(size * 1024);

  it("folds a paste that would push the inline prompt past the threshold", () => {
    const prompt = { value: kb(20), selection: { start: 20 * 1024, end: 20 * 1024 } };
    expect(pastedTextDisposition({ text: kb(20), canAttach: true, prompt })).toBe("attachment");
    // Replacing most of the prompt keeps it under the threshold.
    const replacing = { value: kb(20), selection: { start: 0, end: 19 * 1024 } };
    expect(pastedTextDisposition({ text: kb(20), canAttach: true, prompt: replacing })).toBe(
      "inline",
    );
  });

  it("keeps short pastes inline in a large prompt", () => {
    const prompt = { value: kb(40), selection: { start: 0, end: 0 } };
    expect(pastedTextDisposition({ text: "https://t3.codes", canAttach: true, prompt })).toBe(
      "inline",
    );
  });
});
