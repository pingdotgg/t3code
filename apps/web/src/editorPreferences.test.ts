import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LAST_EDITOR_KEY = "t3code:last-editor";

function createStorage(initialEntries: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initialEntries));
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
}

function setWindowStorage(storage: Storage): void {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: storage },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  vi.restoreAllMocks();
});

describe("resolveAndPersistPreferredEditor", () => {
  it("migrates legacy raw preferred editor values from pre-JSON storage", async () => {
    const storage = createStorage({ [LAST_EDITOR_KEY]: "vscode" });
    setWindowStorage(storage);

    const { resolveAndPersistPreferredEditor } = await import("./editorPreferences");

    expect(resolveAndPersistPreferredEditor(["cursor", "vscode"])).toBe("vscode");
    expect(storage.getItem(LAST_EDITOR_KEY)).toBe('"vscode"');
  });

  it("falls back to the first available editor when the stored value is malformed", async () => {
    const storage = createStorage({ [LAST_EDITOR_KEY]: "{not-json}" });
    setWindowStorage(storage);

    const { resolveAndPersistPreferredEditor } = await import("./editorPreferences");

    expect(resolveAndPersistPreferredEditor(["cursor", "vscode"])).toBe("cursor");
    expect(storage.getItem(LAST_EDITOR_KEY)).toBe('"cursor"');
  });
});
