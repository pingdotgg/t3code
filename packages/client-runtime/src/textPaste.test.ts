import { describe, expect, it } from "vite-plus/test";

import {
  nextPastedTextFileName,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  isPasteAsTextShortcut,
  pastedTextDisposition,
  replaceTextSelection,
  wouldTextPasteExceedLimit,
} from "./textPaste.ts";

describe("pasted text disposition", () => {
  it("keeps ordinary text inline and folds at the 32 KiB boundary", () => {
    expect(
      pastedTextDisposition({
        text: "x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES - 1),
        canAttach: true,
      }),
    ).toBe("inline");
    expect(
      pastedTextDisposition({
        text: "x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES),
        canAttach: true,
      }),
    ).toBe("attachment");
  });

  it("measures UTF-8 bytes instead of UTF-16 characters", () => {
    const text = "🙂".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES / 4);
    expect(text.length).toBeLessThan(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
    expect(pastedTextDisposition({ text, canAttach: true })).toBe("attachment");
  });

  it("keeps text inline for the explicit bypass or without attachment support", () => {
    const text = "x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
    expect(pastedTextDisposition({ text, canAttach: true, bypassAutoAttachment: true })).toBe(
      "inline",
    );
    expect(pastedTextDisposition({ text, canAttach: false })).toBe("inline");
  });

  it("folds a smaller paste when the resulting prompt would exceed the input limit", () => {
    expect(
      pastedTextDisposition({
        text: "small paste",
        canAttach: true,
        wouldExceedInputLimit: true,
      }),
    ).toBe("attachment");
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
