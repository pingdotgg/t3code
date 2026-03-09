import { describe, expect, it } from "vitest";

import {
  readStoredPreferredEditor,
  resolveAndPersistPreferredEditor,
  resolvePreferredEditor,
} from "./editorPreferences";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("resolvePreferredEditor", () => {
  it("prefers a stored editor when it is available", () => {
    const storage = createStorage({ "t3code:last-editor": "vscode" });
    expect(resolvePreferredEditor(["cursor", "vscode", "file-manager"], storage)).toBe("vscode");
  });

  it("falls back to the first available editor in configured preference order", () => {
    const storage = createStorage();
    expect(resolvePreferredEditor(["vscode", "file-manager"], storage)).toBe("vscode");
  });

  it("returns null when no editors are available", () => {
    const storage = createStorage({ "t3code:last-editor": "cursor" });
    expect(resolvePreferredEditor([], storage)).toBeNull();
  });
});

describe("resolveAndPersistPreferredEditor", () => {
  it("persists the inferred fallback editor", () => {
    const storage = createStorage();
    expect(resolveAndPersistPreferredEditor(["vscode", "file-manager"], storage)).toBe("vscode");
    expect(readStoredPreferredEditor(storage)).toBe("vscode");
  });
});
