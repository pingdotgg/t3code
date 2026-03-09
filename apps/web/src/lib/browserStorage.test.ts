import { afterEach, describe, expect, it } from "vitest";

import { getSafeLocalStorage } from "./browserStorage";

const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  if (localStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
  } else {
    // @ts-expect-error cleanup for environments without a configurable localStorage.
    delete globalThis.localStorage;
  }
});

describe("getSafeLocalStorage", () => {
  it("falls back to isolated in-memory storage when reading localStorage throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });

    const firstStorage = getSafeLocalStorage();
    const secondStorage = getSafeLocalStorage();

    firstStorage.setItem("key", "value");

    expect(firstStorage.getItem("key")).toBe("value");
    expect(secondStorage.getItem("key")).toBeNull();
  });

  it("falls back when storage methods throw at call time", () => {
    let reads = 0;
    const throwingStorage = {
      get length() {
        throw new Error("blocked length");
      },
      clear() {
        throw new Error("blocked clear");
      },
      getItem() {
        reads += 1;
        throw new Error("blocked get");
      },
      key() {
        throw new Error("blocked key");
      },
      removeItem() {
        throw new Error("blocked remove");
      },
      setItem() {
        throw new Error("blocked set");
      },
    };

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: throwingStorage,
    });

    const storage = getSafeLocalStorage();

    storage.setItem("key", "value");
    expect(storage.getItem("key")).toBe("value");
    storage.removeItem("key");
    expect(storage.getItem("key")).toBeNull();
    expect(storage.length).toBe(0);
    expect(reads).toBe(0);
  });
});
