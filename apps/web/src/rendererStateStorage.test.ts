import { describe, expect, it, vi } from "vite-plus/test";

import { createHydrationGuardedRendererStateStorage } from "./rendererStateStorage";

function createStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  };
}

describe("createHydrationGuardedRendererStateStorage", () => {
  it("keeps browser localStorage synchronous and writable", () => {
    const browser = createStorage();
    const stateStorage = createHydrationGuardedRendererStateStorage({
      key: "ui-state",
      browserStorage: browser.storage,
    });

    stateStorage.storage.setItem("ignored-by-browser", '{"projectOrder":[]}');

    expect(stateStorage.requiresExplicitHydration).toBe(false);
    expect(stateStorage.writesEnabled()).toBe(true);
    expect(browser.values.get("ignored-by-browser")).toBe('{"projectOrder":[]}');
  });

  it("blocks desktop writes until hydration completes", async () => {
    const getRendererState = vi.fn().mockResolvedValue('{"projectOrder":["project-a"]}');
    const setRendererState = vi.fn().mockResolvedValue(undefined);
    const stateStorage = createHydrationGuardedRendererStateStorage({
      key: "ui-state",
      browserStorage: createStorage().storage,
      desktopPersistence: {
        getRendererState,
        setRendererState,
      },
    });

    await expect(stateStorage.storage.getItem("t3code:ui-state:v1")).resolves.toBe(
      '{"projectOrder":["project-a"]}',
    );
    await stateStorage.storage.setItem("t3code:ui-state:v1", '{"projectOrder":[]}');
    expect(setRendererState).not.toHaveBeenCalled();

    stateStorage.enableWrites();
    await stateStorage.storage.setItem("t3code:ui-state:v1", '{"projectOrder":["project-b"]}');
    await stateStorage.storage.removeItem("t3code:ui-state:v1");

    expect(setRendererState).toHaveBeenNthCalledWith(
      1,
      "ui-state",
      '{"projectOrder":["project-b"]}',
    );
    expect(setRendererState).toHaveBeenNthCalledWith(2, "ui-state", null);
  });

  it("keeps desktop writes blocked after a hydration read failure", async () => {
    const getRendererState = vi.fn().mockRejectedValue(new Error("read failed"));
    const setRendererState = vi.fn().mockResolvedValue(undefined);
    const stateStorage = createHydrationGuardedRendererStateStorage({
      key: "ui-state",
      browserStorage: createStorage().storage,
      desktopPersistence: {
        getRendererState,
        setRendererState,
      },
    });

    await expect(stateStorage.storage.getItem("t3code:ui-state:v1")).rejects.toThrow("read failed");
    await stateStorage.storage.setItem("t3code:ui-state:v1", '{"projectOrder":[]}');

    expect(stateStorage.writesEnabled()).toBe(false);
    expect(setRendererState).not.toHaveBeenCalled();
  });
});
