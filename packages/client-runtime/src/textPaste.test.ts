import {
  DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD,
  PASTED_TEXT_ATTACHMENT_THRESHOLDS,
} from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  nextPastedTextFileName,
  isPasteAsTextShortcut,
  pastedTextDisposition,
  pastedTextThresholdLabel,
  replaceTextSelection,
  wouldTextPasteExceedLimit,
} from "./textPaste.ts";

const thresholdBytes = DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD;

describe("pasted text disposition", () => {
  it("keeps ordinary text inline and folds at the default 32 KiB boundary", () => {
    expect(
      pastedTextDisposition({
        text: "x".repeat(thresholdBytes - 1),
        canAttach: true,
        thresholdBytes,
      }),
    ).toBe("inline");
    expect(
      pastedTextDisposition({ text: "x".repeat(thresholdBytes), canAttach: true, thresholdBytes }),
    ).toBe("attachment");
  });

  it("folds at each selectable threshold", () => {
    for (const threshold of PASTED_TEXT_ATTACHMENT_THRESHOLDS) {
      expect(
        pastedTextDisposition({
          text: "x".repeat(threshold - 1),
          canAttach: true,
          thresholdBytes: threshold,
        }),
      ).toBe("inline");
      expect(
        pastedTextDisposition({
          text: "x".repeat(threshold),
          canAttach: true,
          thresholdBytes: threshold,
        }),
      ).toBe("attachment");
    }
  });

  it("counts bytes at the 1 KB preset, so non-Latin text folds with fewer characters", () => {
    const text = "日本語".repeat(120);
    expect(text.length).toBeLessThan(1_000);
    expect(pastedTextDisposition({ text, canAttach: true, thresholdBytes: 1_000 })).toBe(
      "attachment",
    );
  });

  it("measures UTF-8 bytes instead of UTF-16 characters", () => {
    const text = "🙂".repeat(thresholdBytes / 4);
    expect(text.length).toBeLessThan(thresholdBytes);
    expect(pastedTextDisposition({ text, canAttach: true, thresholdBytes })).toBe("attachment");
  });

  it("keeps text inline for the explicit bypass or without attachment support", () => {
    const text = "x".repeat(thresholdBytes);
    expect(
      pastedTextDisposition({ text, canAttach: true, thresholdBytes, bypassAutoAttachment: true }),
    ).toBe("inline");
    expect(pastedTextDisposition({ text, canAttach: false, thresholdBytes })).toBe("inline");
  });

  it("folds a smaller paste when the resulting prompt would exceed the input limit", () => {
    expect(
      pastedTextDisposition({
        text: "small paste",
        canAttach: true,
        thresholdBytes,
        wouldExceedInputLimit: true,
      }),
    ).toBe("attachment");
  });
});

describe("pasted text threshold labels", () => {
  it("leads with the size and approximates the character count", () => {
    expect(PASTED_TEXT_ATTACHMENT_THRESHOLDS.map(pastedTextThresholdLabel)).toEqual([
      "1 KB (~1,000 chars)",
      "5 KB (~5,000 chars)",
      "32 KB (~32,000 chars)",
    ]);
  });
});

describe("pasted text attachment names", () => {
  it("uses the first available readable sequence", () => {
    expect(nextPastedTextFileName([])).toBe("pasted-text.txt");
    expect(nextPastedTextFileName(["PASTED-TEXT.TXT", "pasted-text-2.txt"])).toBe(
      "pasted-text-3.txt",
    );
  });
});

describe("paste-as-text shortcut", () => {
  it.each([
    { metaKey: true, ctrlKey: false, macPlatform: true },
    { metaKey: false, ctrlKey: true, macPlatform: false },
  ])("accepts the platform modifier with Shift", ({ metaKey, ctrlKey, macPlatform }) => {
    expect(
      isPasteAsTextShortcut(
        {
          key: "V",
          metaKey,
          ctrlKey,
          shiftKey: true,
          altKey: false,
        },
        macPlatform,
      ),
    ).toBe(true);
  });

  it("does not claim ordinary or alternate paste chords", () => {
    expect(
      isPasteAsTextShortcut(
        {
          key: "v",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
        },
        true,
      ),
    ).toBe(false);
    expect(
      isPasteAsTextShortcut(
        {
          key: "v",
          metaKey: true,
          ctrlKey: false,
          shiftKey: true,
          altKey: true,
        },
        true,
      ),
    ).toBe(false);
  });

  it("rejects the other platform's modifier", () => {
    const event = {
      key: "v",
      metaKey: false,
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
    };
    expect(isPasteAsTextShortcut(event, true)).toBe(false);
    expect(isPasteAsTextShortcut({ ...event, metaKey: true, ctrlKey: false }, false)).toBe(false);
  });
});

describe("text paste insertion", () => {
  it("replaces the selected range and returns the collapsed cursor", () => {
    expect(
      replaceTextSelection({
        value: "before old after",
        selection: { start: 7, end: 10 },
        text: "new",
      }),
    ).toEqual({ value: "before new after", cursor: 10 });
  });

  it("clamps stale native selections", () => {
    expect(
      replaceTextSelection({ value: "abc", selection: { start: 20, end: 30 }, text: "!" }),
    ).toEqual({ value: "abc!", cursor: 4 });
  });

  it("measures the replacement value after removing the selected range", () => {
    expect(
      wouldTextPasteExceedLimit({
        valueLength: 100,
        selection: { start: 40, end: 80 },
        textLength: 30,
        maxLength: 100,
      }),
    ).toBe(false);
    expect(
      wouldTextPasteExceedLimit({
        valueLength: 100,
        selection: { start: 40, end: 80 },
        textLength: 41,
        maxLength: 100,
      }),
    ).toBe(true);
  });
});
