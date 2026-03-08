import { assert, describe, it } from "vitest";

import {
  parseStoredSidebarOpenState,
  persistSidebarOpenState,
  resolveSidebarOpenState,
  type SidebarOpenStateStorage,
} from "./sidebar.persistence";

function createStorage(initialEntries: Record<string, string> = {}): SidebarOpenStateStorage {
  const values = new Map(Object.entries(initialEntries));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("parseStoredSidebarOpenState", () => {
  it("accepts persisted boolean strings", () => {
    assert.strictEqual(parseStoredSidebarOpenState("true"), true);
    assert.strictEqual(parseStoredSidebarOpenState("false"), false);
  });

  it("rejects unknown values", () => {
    assert.strictEqual(parseStoredSidebarOpenState(null), null);
    assert.strictEqual(parseStoredSidebarOpenState(""), null);
    assert.strictEqual(parseStoredSidebarOpenState("collapsed"), null);
  });
});

describe("resolveSidebarOpenState", () => {
  it("falls back to the default when persistence is unavailable", () => {
    assert.strictEqual(resolveSidebarOpenState({ defaultOpen: true }), true);
    assert.strictEqual(
      resolveSidebarOpenState({
        defaultOpen: false,
        storage: createStorage({ chat_main_sidebar_open: "true" }),
      }),
      false,
    );
  });

  it("reads persisted state when storage and a key are provided", () => {
    const storage = createStorage({ chat_main_sidebar_open: "false" });

    assert.strictEqual(
      resolveSidebarOpenState({
        defaultOpen: true,
        storage,
        storageKey: "chat_main_sidebar_open",
      }),
      false,
    );
  });
});

describe("persistSidebarOpenState", () => {
  it("writes the current state to storage", () => {
    const storage = createStorage();

    persistSidebarOpenState({
      open: false,
      storage,
      storageKey: "chat_main_sidebar_open",
    });

    assert.strictEqual(storage.getItem("chat_main_sidebar_open"), "false");
  });

  it("does nothing without a storage key", () => {
    const storage = createStorage();

    persistSidebarOpenState({ open: true, storage });

    assert.strictEqual(storage.getItem("chat_main_sidebar_open"), null);
  });
});
