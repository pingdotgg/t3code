import { describe, expect, it } from "vite-plus/test";
import { dictationKeybindingFromKeyboardEvent } from "./DictationKeybindRecorder.logic";

function keyboardEvent(
  overrides: Partial<
    Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
  > = {},
) {
  return {
    key: "m",
    code: "KeyM",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("dictationKeybindingFromKeyboardEvent", () => {
  it("records an explicit Linux control chord for the desktop input bridge", () => {
    expect(
      dictationKeybindingFromKeyboardEvent(
        keyboardEvent({ ctrlKey: true, shiftKey: true }),
        "Linux x86_64",
      ),
    ).toBe("ctrl+shift+m");
  });

  it("records an explicit macOS command chord", () => {
    expect(
      dictationKeybindingFromKeyboardEvent(keyboardEvent({ key: "k", metaKey: true }), "MacIntel"),
    ).toBe("meta+k");
  });

  it("records modifier-only chords", () => {
    expect(
      dictationKeybindingFromKeyboardEvent(
        keyboardEvent({ key: "Control", ctrlKey: true }),
        "Linux x86_64",
      ),
    ).toBe("ctrl");
    expect(
      dictationKeybindingFromKeyboardEvent(
        keyboardEvent({ key: "Shift", ctrlKey: true, shiftKey: true }),
        "Linux x86_64",
      ),
    ).toBe("ctrl+shift");
  });

  it("allows an unmodified supported key", () => {
    expect(dictationKeybindingFromKeyboardEvent(keyboardEvent(), "Linux x86_64")).toBe("m");
  });

  it("allows a function key to be recorded without a modifier", () => {
    expect(dictationKeybindingFromKeyboardEvent(keyboardEvent({ key: "F8" }), "Linux x86_64")).toBe(
      "f8",
    );
  });

  it("ignores keys the desktop input bridge cannot send", () => {
    expect(
      dictationKeybindingFromKeyboardEvent(keyboardEvent({ key: "CapsLock" }), "Linux x86_64"),
    ).toBeNull();
  });
});
