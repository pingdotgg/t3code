import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { PreviewAutomationPressInput, PreviewAutomationPressKey } from "./previewAutomation.ts";

const decodePressKey = Schema.decodeUnknownSync(PreviewAutomationPressKey);
const decodePressInput = Schema.decodeUnknownSync(PreviewAutomationPressInput);

describe("preview automation press key", () => {
  it.each(["Enter", "Space", "ArrowDown", "Delete", "F1", "F12", "!", "~", "0", "A", "z"] as const)(
    "accepts %s",
    (key) => {
      expect(decodePressKey(key)).toBe(key);
      expect(decodePressInput({ key })).toEqual({ key });
    },
  );

  it("accepts every current named key", () => {
    const namedKeys = [
      "Escape",
      "Backspace",
      "Tab",
      "Enter",
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "CapsLock",
      "Space",
      "PageUp",
      "PageDown",
      "End",
      "Home",
      "ArrowLeft",
      "ArrowUp",
      "ArrowRight",
      "ArrowDown",
      "Insert",
      "Delete",
    ];

    for (const key of namedKeys) {
      expect(decodePressKey(key)).toBe(key);
    }
  });

  it("accepts F1 through F12", () => {
    for (let index = 1; index <= 12; index += 1) {
      const key = `F${index}`;
      expect(decodePressKey(key)).toBe(key);
    }
  });

  it("accepts every printable ASCII character except space", () => {
    for (let codePoint = 33; codePoint <= 126; codePoint += 1) {
      const key = String.fromCodePoint(codePoint);
      expect(decodePressKey(key)).toBe(key);
    }
  });

  it("directs Unicode text to preview_type in the agent-facing schema", () => {
    const jsonSchema = Schema.toJsonSchemaDocument(PreviewAutomationPressInput).schema;

    expect(JSON.stringify(jsonSchema)).toContain("Use preview_type for Unicode text.");
  });

  it.each([" ", "Return", "F0", "F13", "\u00e9", "\u{1f642}"])(
    "rejects unsupported key %s",
    (key) => {
      expect(() => decodePressKey(key)).toThrow();
      expect(() => decodePressInput({ key })).toThrow();
    },
  );
});
