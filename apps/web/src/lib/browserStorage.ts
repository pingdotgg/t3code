const memoryStorageEntries = new Map<string, string>();

const memoryStorage: Storage = {
  get length() {
    return memoryStorageEntries.size;
  },
  clear() {
    memoryStorageEntries.clear();
  },
  getItem(key) {
    return memoryStorageEntries.get(key) ?? null;
  },
  key(index) {
    return Array.from(memoryStorageEntries.keys())[index] ?? null;
  },
  removeItem(key) {
    memoryStorageEntries.delete(key);
  },
  setItem(key, value) {
    memoryStorageEntries.set(key, String(value));
  },
};

function isStorageLike(value: unknown): value is Storage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Storage>;

  return (
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function" &&
    typeof candidate.clear === "function" &&
    typeof candidate.key === "function"
  );
}

export function getSafeLocalStorage(): Storage {
  const candidate = (() => {
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  })();

  if (isStorageLike(candidate)) {
    return candidate;
  }

  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: memoryStorage,
    });
  } catch {
    // Ignore assignment failures and keep the in-memory fallback local to callers.
  }

  return memoryStorage;
}
