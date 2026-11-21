import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("local storage errors", () => {
  it("retries when access to browser storage becomes available", async () => {
    const storage = createStorage();
    storage.setItem("read-key", JSON.stringify("saved value"));
    let blocked = true;
    vi.stubGlobal("window", {
      get localStorage() {
        if (blocked) throw new Error("storage unavailable");
        return storage;
      },
    });
    const { getLocalStorageItem, LocalStorageOperationError } = await import("./useLocalStorage");

    expect(() => getLocalStorageItem("read-key", Schema.String)).toThrow(
      LocalStorageOperationError,
    );
    blocked = false;
    expect(getLocalStorageItem("read-key", Schema.String)).toBe("saved value");
  });

  it("reads back writes the browser rejects, per key, until another tab changes the key", async () => {
    let rejecting = true;
    const storage = createStorage();
    const accept = storage.setItem;
    storage.setItem = (key, value) => {
      if (rejecting) throw new DOMException("Storage is full.", "QuotaExceededError");
      accept(key, value);
    };
    vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: storage }));
    using _log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { readLocalStorageValue, writeLocalStorageValue } = await import("./useLocalStorage");
    const schema = Schema.NullOr(Schema.String);

    writeLocalStorageValue("a", "unsaved a", null, schema);
    writeLocalStorageValue("b", "unsaved b", null, schema);
    expect(readLocalStorageValue("a", null, schema)).toBe("unsaved a");
    expect(readLocalStorageValue("b", null, schema)).toBe("unsaved b");

    rejecting = false;
    accept("a", JSON.stringify("other tab"));
    window.dispatchEvent(Object.assign(new Event("storage"), { key: "a" }));
    expect(readLocalStorageValue("a", null, schema)).toBe("other tab");
    expect(readLocalStorageValue("b", null, schema)).toBe("unsaved b");
  });
});
