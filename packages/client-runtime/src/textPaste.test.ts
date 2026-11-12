import { PASTED_TEXT_ATTACHMENT_THRESHOLDS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  isPasteAsTextShortcut,
  pastedTextDisposition,
  pastedTextThresholdLabel,
} from "./textPaste.ts";

describe("isPasteAsTextShortcut", () => {
  it("accepts the V key on non-Latin layouts but follows the letter on Latin ones", () => {
    const chord = { metaKey: false, ctrlKey: true, shiftKey: true, altKey: false };
    expect(isPasteAsTextShortcut({ ...chord, key: "М", code: "KeyV" }, false)).toBe(true);
    expect(isPasteAsTextShortcut({ ...chord, key: "k", code: "KeyV" }, false)).toBe(false);
    expect(isPasteAsTextShortcut({ ...chord, key: "V", code: "Period" }, false)).toBe(true);
  });
});

describe("pastedTextDisposition", () => {
  it("folds at each selectable threshold", () => {
    for (const thresholdBytes of PASTED_TEXT_ATTACHMENT_THRESHOLDS) {
      expect(
        pastedTextDisposition({
          text: "x".repeat(thresholdBytes - 1),
          canAttach: true,
          thresholdBytes,
        }),
      ).toBe("inline");
      expect(
        pastedTextDisposition({
          text: "x".repeat(thresholdBytes),
          canAttach: true,
          thresholdBytes,
        }),
      ).toBe("attachment");
    }
  });

  it("counts UTF-8 bytes, so non-Latin text folds with fewer characters", () => {
    const text = "日本語".repeat(120);
    expect(text.length).toBeLessThan(1_000);
    expect(pastedTextDisposition({ text, canAttach: true, thresholdBytes: 1_000 })).toBe(
      "attachment",
    );
  });
});

describe("pastedTextThresholdLabel", () => {
  it("leads with the size and approximates the character count", () => {
    expect(PASTED_TEXT_ATTACHMENT_THRESHOLDS.map(pastedTextThresholdLabel)).toEqual([
      "1 KB (~1,000 chars)",
      "5 KB (~5,000 chars)",
      "32 KB (~32,000 chars)",
    ]);
  });
});
