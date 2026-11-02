import { describe, expect, it } from "vite-plus/test";

import { isPasteAsTextShortcut } from "./textPaste.ts";

describe("isPasteAsTextShortcut", () => {
  it("accepts the V key on non-Latin layouts but follows the letter on Latin ones", () => {
    const chord = { metaKey: false, ctrlKey: true, shiftKey: true, altKey: false };
    expect(isPasteAsTextShortcut({ ...chord, key: "М", code: "KeyV" }, false)).toBe(true);
    expect(isPasteAsTextShortcut({ ...chord, key: "k", code: "KeyV" }, false)).toBe(false);
    expect(isPasteAsTextShortcut({ ...chord, key: "V", code: "Period" }, false)).toBe(true);
  });
});
