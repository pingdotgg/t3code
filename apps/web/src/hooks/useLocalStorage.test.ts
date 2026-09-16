import * as Schema from "effect/Schema";
import { act, createElement, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
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

async function loadWithStorage(storage: Storage) {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: storage }));
  vi.stubGlobal("localStorage", storage);
  return import("./useLocalStorage");
}

let renderer: ReactTestRenderer | undefined;

async function mountPreference(storage: Storage) {
  const { useLocalStorage } = await loadWithStorage(storage);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let preference: ReturnType<typeof useLocalStorage<boolean, boolean>>;

  function PreferenceProbe() {
    const state = useLocalStorage("preference-key", false, Schema.Boolean);
    useLayoutEffect(() => {
      preference = state;
    });
    return null;
  }

  await act(() => {
    renderer = create(createElement(PreferenceProbe));
  });

  return {
    get value() {
      return preference[0];
    },
    get setValue() {
      return preference[1];
    },
  };
}

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("local storage preferences", () => {
  describe.each([
    { update: "direct", value: true },
    { update: "functional", value: (current: boolean) => !current },
  ])("$update updates", ({ value }) => {
    it.each(["", "not-json", '"old-format"'])(
      "replaces invalid value %j on edit",
      async (stored) => {
        const storage = createStorage();
        storage.setItem("preference-key", stored);
        const preference = await mountPreference(storage);

        expect(preference.value).toBe(false);
        expect(storage.getItem("preference-key")).toBe(stored);

        await act(() => preference.setValue(value));

        expect(preference.value).toBe(true);
        expect(storage.getItem("preference-key")).toBe("true");

        await act(() => renderer?.unmount());
        const reloadedPreference = await mountPreference(storage);
        expect(reloadedPreference.value).toBe(true);
      },
    );
  });

  it("applies successive functional updates to the latest stored value", async () => {
    const storage = createStorage();
    storage.setItem("preference-key", "true");
    const preference = await mountPreference(storage);

    await act(() => {
      preference.setValue((current) => !current);
      preference.setValue((current) => !current);
    });

    expect(preference.value).toBe(true);
    expect(storage.getItem("preference-key")).toBe("true");
  });

  it("does not replace an unreadable preference with the default", async () => {
    const storage = createStorage();
    storage.setItem("preference-key", "true");
    const preference = await mountPreference(storage);
    const cause = new Error("storage unavailable");
    const read = vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw cause;
    });
    const consoleError = vi.spyOn(console, "error");

    await act(() => preference.setValue((current) => current));

    read.mockRestore();
    expect(storage.getItem("preference-key")).toBe("true");
    expect(preference.value).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      "[LOCALSTORAGE] Could not update stored value.",
      expect.objectContaining({ operation: "read", storageKey: "preference-key", cause }),
    );
  });

  it("keeps invalid data when a write fails and allows retrying", async () => {
    const storage = createStorage();
    storage.setItem("preference-key", "not-json");
    const preference = await mountPreference(storage);
    const cause = new Error("storage quota exceeded");
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw cause;
    });
    const consoleError = vi.spyOn(console, "error");

    await act(() => preference.setValue(true));

    expect(storage.getItem("preference-key")).toBe("not-json");
    expect(preference.value).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      "[LOCALSTORAGE] Could not update stored value.",
      expect.objectContaining({ operation: "write", storageKey: "preference-key", cause }),
    );

    write.mockRestore();
    await act(() => preference.setValue(true));
    expect(preference.value).toBe(true);
    expect(storage.getItem("preference-key")).toBe("true");
  });

  it("keeps invalid data when the updater fails", async () => {
    const storage = createStorage();
    storage.setItem("preference-key", "not-json");
    const preference = await mountPreference(storage);
    const cause = new Error("update failed");
    const consoleError = vi.spyOn(console, "error");

    await act(() =>
      preference.setValue(() => {
        throw cause;
      }),
    );

    expect(storage.getItem("preference-key")).toBe("not-json");
    expect(preference.value).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      "[LOCALSTORAGE] Could not update stored value.",
      expect.objectContaining({ operation: "update", storageKey: "preference-key", cause }),
    );
  });
});

describe("local storage errors", () => {
  it("preserves read failure context", async () => {
    const cause = new Error("storage unavailable");
    const { getLocalStorageItem, LocalStorageOperationError } = await loadWithStorage(
      createStorage({
        getItem: () => {
          throw cause;
        },
      }),
    );

    try {
      getLocalStorageItem("read-key", Schema.String);
      expect.unreachable("expected the read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "read-key",
        cause,
      });
    }
  });

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

  it.each(["", "not-json"])("preserves decode failure context for %j", async (value) => {
    const { getLocalStorageItem, LocalStorageOperationError } = await loadWithStorage(
      createStorage({ getItem: () => value }),
    );

    try {
      getLocalStorageItem("decode-key", Schema.String);
      expect.unreachable("expected decoding to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "decode",
        storageKey: "decode-key",
        cause: expect.anything(),
      });
    }
  });

  it("preserves write failure context", async () => {
    const cause = new Error("storage quota exceeded");
    const { LocalStorageOperationError, setLocalStorageItem } = await loadWithStorage(
      createStorage({
        setItem: () => {
          throw cause;
        },
      }),
    );

    try {
      setLocalStorageItem("write-key", "value", Schema.String);
      expect.unreachable("expected the write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "write-key",
        cause,
      });
    }
  });

  it("preserves removal failure context", async () => {
    const cause = new Error("storage unavailable");
    const { LocalStorageOperationError, removeLocalStorageItem } = await loadWithStorage(
      createStorage({
        removeItem: () => {
          throw cause;
        },
      }),
    );

    try {
      removeLocalStorageItem("remove-key");
      expect.unreachable("expected the removal to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "remove",
        storageKey: "remove-key",
        cause,
      });
    }
  });
});
