import { describe, expect, it } from "vitest";

import {
  LAST_EDITOR_KEY,
  rememberPreferredEditor,
  normalizeEditorPreference,
  readPreferredEditor,
  resolveEffectiveEditor,
  resolvePreferredCommandEditor,
} from "./editorPreferences";

function createStorage(): Storage {
  const backing = new Map<string, string>();
  return {
    get length() {
      return backing.size;
    },
    clear() {
      backing.clear();
    },
    getItem(key) {
      return backing.get(key) ?? null;
    },
    key(index) {
      return [...backing.keys()][index] ?? null;
    },
    removeItem(key) {
      backing.delete(key);
    },
    setItem(key, value) {
      backing.set(key, value);
    },
  };
}

describe("normalizeEditorPreference", () => {
  it("returns known editor ids and discards unknown values", () => {
    expect(normalizeEditorPreference("vscode-insiders")).toBe("vscode-insiders");
    expect(normalizeEditorPreference("not-an-editor")).toBeNull();
    expect(normalizeEditorPreference(null)).toBeNull();
  });
});

describe("readPreferredEditor", () => {
  it("reads the saved last-used editor", () => {
    const storage = createStorage();
    storage.setItem(LAST_EDITOR_KEY, "vscodium");

    expect(readPreferredEditor(storage)).toBe("vscodium");
  });

  it("ignores invalid stored values", () => {
    const storage = createStorage();
    storage.setItem(LAST_EDITOR_KEY, "unknown");

    expect(readPreferredEditor(storage)).toBeNull();
  });
});

describe("rememberPreferredEditor", () => {
  it("stores the last-used editor", () => {
    const storage = createStorage();

    rememberPreferredEditor("vscode-insiders", storage);

    expect(storage.getItem(LAST_EDITOR_KEY)).toBe("vscode-insiders");
  });
});

describe("resolveEffectiveEditor", () => {
  it("uses the saved default when it is available", () => {
    const storage = createStorage();
    storage.setItem(LAST_EDITOR_KEY, "vscodium");

    expect(resolveEffectiveEditor(["vscode-insiders", "vscodium"], storage)).toBe("vscodium");
  });

  it("falls back to the first available editor when the saved one is unavailable", () => {
    const storage = createStorage();
    storage.setItem(LAST_EDITOR_KEY, "vscodium");

    expect(resolveEffectiveEditor(["vscode-insiders"], storage)).toBe("vscode-insiders");
  });
});

describe("resolvePreferredCommandEditor", () => {
  it("returns the saved command-based editor when valid", () => {
    const storage = createStorage();
    storage.setItem(LAST_EDITOR_KEY, "vscodium");

    expect(resolvePreferredCommandEditor(storage)).toBe("vscodium");
  });

  it("falls back to the first command editor when the saved editor has no command", () => {
    const storage = createStorage();
    storage.setItem(LAST_EDITOR_KEY, "file-manager");

    expect(resolvePreferredCommandEditor(storage)).toBe("cursor");
  });
});
