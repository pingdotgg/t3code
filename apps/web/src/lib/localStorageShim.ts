const storageBacking = new Map<string, string>();

function createMemoryStorage(): Storage {
  return {
    get length() {
      return storageBacking.size;
    },
    clear() {
      storageBacking.clear();
    },
    getItem(key) {
      return storageBacking.get(String(key)) ?? null;
    },
    key(index) {
      if (index < 0 || index >= storageBacking.size) {
        return null;
      }
      return Array.from(storageBacking.keys())[index] ?? null;
    },
    removeItem(key) {
      storageBacking.delete(String(key));
    },
    setItem(key, value) {
      storageBacking.set(String(key), String(value));
    },
  };
}

export function ensureLocalStorage(): Storage {
  const candidate = globalThis.localStorage;
  if (
    candidate &&
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function" &&
    typeof candidate.clear === "function"
  ) {
    return candidate;
  }

  const fallbackStorage = createMemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: fallbackStorage,
    configurable: true,
    writable: true,
  });
  return fallbackStorage;
}
