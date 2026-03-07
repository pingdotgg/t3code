class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.#values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, String(value));
  }
}

const storageLike = globalThis.localStorage;
const hasCompleteStorageApi =
  typeof storageLike?.getItem === "function" &&
  typeof storageLike.setItem === "function" &&
  typeof storageLike.removeItem === "function" &&
  typeof storageLike.clear === "function" &&
  typeof storageLike.key === "function";

if (!hasCompleteStorageApi) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: new MemoryStorage(),
  });
}
