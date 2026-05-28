import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createFakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
}

const STORAGE_KEY = "t3.pendingPairingToken";
const HOUR_MS = 60 * 60 * 1000;

describe("pendingPairingToken", () => {
  let fakeStorage: Storage;

  beforeEach(() => {
    fakeStorage = createFakeStorage();
    vi.stubGlobal("window", { localStorage: fakeStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function loadModule() {
    vi.resetModules();
    return await import("./pendingPairingToken");
  }

  it("round-trips a token via save and peek", async () => {
    const { savePendingPairingToken, peekPendingPairingToken } = await loadModule();
    savePendingPairingToken("ABC123", 1_000_000);
    expect(peekPendingPairingToken(1_000_000)).toBe("ABC123");
  });

  it("trims whitespace and ignores empty tokens", async () => {
    const { savePendingPairingToken, peekPendingPairingToken } = await loadModule();
    savePendingPairingToken("   ", 1_000_000);
    expect(peekPendingPairingToken(1_000_000)).toBeNull();

    savePendingPairingToken("  PADDED  ", 1_000_000);
    expect(peekPendingPairingToken(1_000_000)).toBe("PADDED");
  });

  it("returns null and removes the key once the TTL expires", async () => {
    const { savePendingPairingToken, peekPendingPairingToken } = await loadModule();
    savePendingPairingToken("ABC", 0);
    expect(peekPendingPairingToken(23 * HOUR_MS)).toBe("ABC");
    expect(peekPendingPairingToken(23 * HOUR_MS + 1)).toBeNull();
    expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("consume returns the token and clears storage", async () => {
    const { savePendingPairingToken, consumePendingPairingToken, peekPendingPairingToken } =
      await loadModule();
    savePendingPairingToken("XYZ", 1_000_000);
    expect(consumePendingPairingToken(1_000_000)).toBe("XYZ");
    expect(peekPendingPairingToken(1_000_000)).toBeNull();
  });

  it("clear removes any stored token", async () => {
    const { savePendingPairingToken, clearPendingPairingToken, peekPendingPairingToken } =
      await loadModule();
    savePendingPairingToken("XYZ", 1_000_000);
    clearPendingPairingToken();
    expect(peekPendingPairingToken(1_000_000)).toBeNull();
  });

  it("ignores malformed payloads gracefully", async () => {
    const { peekPendingPairingToken } = await loadModule();

    fakeStorage.setItem(STORAGE_KEY, "not-json");
    expect(peekPendingPairingToken()).toBeNull();

    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 1, savedAt: 0 }));
    expect(peekPendingPairingToken()).toBeNull();

    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({ token: "ok" }));
    expect(peekPendingPairingToken()).toBeNull();
  });
});
