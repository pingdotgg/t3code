import { describe, expect, it } from "vite-plus/test";
import { recordingKeyLabel, recordingKeysAreSensitive } from "./RecordingInput.ts";

const key = (
  value: string,
  modifiers: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  key: value,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("recording key labels", () => {
  it("formats macOS and other-platform shortcuts", () => {
    expect(recordingKeyLabel(key("c", { metaKey: true }), true)).toBe("⌘C");
    expect(recordingKeyLabel(key("c", { ctrlKey: true }), false)).toBe("Ctrl + C");
    expect(recordingKeyLabel(key("Tab", { altKey: true, shiftKey: true }), true)).toBe("⌥⇧⇥");
  });
  it("shows held modifiers once and labels navigation keys", () => {
    expect(recordingKeyLabel(key("Meta", { metaKey: true }), true)).toBe("⌘");
    expect(recordingKeyLabel(key("Shift", { shiftKey: true }), false)).toBe("Shift");
    expect(recordingKeyLabel(key("ArrowLeft"), true)).toBe("←");
    expect(recordingKeyLabel(key(" "), false)).toBe("Space");
  });
  it.each(["Dead", "Unidentified", "Process", ""])("excludes composition key %s", (value) => {
    expect(recordingKeyLabel(key(value), true)).toBeNull();
  });
});

describe("recording key privacy", () => {
  const field = (type: string) => ({ tagName: "INPUT", getAttribute: () => type });
  const sensitive = (activeElement: unknown) =>
    recordingKeysAreSensitive({ activeElement } as Document);
  it("excludes password fields and their shadow-root focus", () => {
    expect(sensitive(field("password"))).toBe(true);
    expect(sensitive({ shadowRoot: { activeElement: field("password") } })).toBe(true);
    expect(sensitive(field("text"))).toBe(false);
  });
  it("excludes iframe focus whose field cannot be inspected", () => {
    expect(sensitive({ tagName: "IFRAME" })).toBe(true);
    expect(sensitive({ tagName: "SECRET-FIELD" })).toBe(true);
  });
});
