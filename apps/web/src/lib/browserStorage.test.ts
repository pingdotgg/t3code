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
  it("falls back to in-memory storage when reading localStorage throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });

    const storage = getSafeLocalStorage();

    storage.setItem("key", "value");

    expect(storage.getItem("key")).toBe("value");
    expect(getSafeLocalStorage().getItem("key")).toBe("value");
  });
});
