function createMemoryStorage(): Storage {
  const memoryStorageEntries = new Map<string, string>();

  return {
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
}

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

  if (!isStorageLike(candidate)) {
    return createMemoryStorage();
  }

  const fallbackStorage = createMemoryStorage();
  let activeStorage: Storage = candidate;

  const withStorage = <T>(operation: (storage: Storage) => T): T => {
    try {
      return operation(activeStorage);
    } catch {
      activeStorage = fallbackStorage;
      return operation(activeStorage);
    }
  };

  return {
    get length() {
      return withStorage((storage) => storage.length);
    },
    clear() {
      withStorage((storage) => storage.clear());
    },
    getItem(key) {
      return withStorage((storage) => storage.getItem(key));
    },
    key(index) {
      return withStorage((storage) => storage.key(index));
    },
    removeItem(key) {
      withStorage((storage) => storage.removeItem(key));
    },
    setItem(key, value) {
      withStorage((storage) => storage.setItem(key, value));
    },
  };
}
