export interface ComposerImageBlobStore {
  put(id: string, blob: Blob): Promise<void>;
  get(id: string): Promise<Blob | undefined>;
  delete(id: string): Promise<void>;
  /** Remove keys not in `keepIds`. */
  deleteAllExcept(keepIds: ReadonlySet<string>): Promise<void>;
}

const DATABASE_NAME = "t3code:composer-image-blobs";
const DATABASE_VERSION = 1;
const STORE_NAME = "blobs";

let database: Promise<IDBDatabase> | undefined;
let processStore: ComposerImageBlobStore | undefined;
let testStore: ComposerImageBlobStore | null = null;

export function createMemoryComposerImageBlobStore(): ComposerImageBlobStore {
  const blobs = new Map<string, Blob>();
  return {
    async put(id, blob) {
      blobs.set(id, blob);
    },
    async get(id) {
      return blobs.get(id);
    },
    async delete(id) {
      blobs.delete(id);
    },
    async deleteAllExcept(keepIds) {
      for (const id of blobs.keys()) {
        if (!keepIds.has(id)) blobs.delete(id);
      }
    },
  };
}

export function createIndexedDbComposerImageBlobStore(): ComposerImageBlobStore {
  return {
    async put(id, blob) {
      await withStore("readwrite", (store) => store.put(blob, id));
    },
    async get(id) {
      try {
        const value = await withStore("readonly", (store) => store.get(id));
        return value instanceof Blob ? value : undefined;
      } catch {
        return undefined;
      }
    },
    async delete(id) {
      await withStore("readwrite", (store) => store.delete(id));
    },
    async deleteAllExcept(keepIds) {
      const transaction = (await openDatabase()).transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const keysRequest = store.getAllKeys();
      keysRequest.addEventListener("success", () => {
        for (const key of keysRequest.result) {
          if (!keepIds.has(String(key))) store.delete(key);
        }
      });
      await completed(transaction);
    },
  };
}

export function getComposerImageBlobStore(): ComposerImageBlobStore {
  if (testStore) return testStore;
  return (processStore ??= createDefaultComposerImageBlobStore());
}

export function setComposerImageBlobStoreForTests(store: ComposerImageBlobStore | null): void {
  testStore = store;
}

function createDefaultComposerImageBlobStore(): ComposerImageBlobStore {
  return typeof indexedDB === "undefined"
    ? createMemoryComposerImageBlobStore()
    : createIndexedDbComposerImageBlobStore();
}

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      for (const name of request.result.objectStoreNames) {
        if (name !== STORE_NAME) request.result.deleteObjectStore(name);
      }
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () =>
      reject(new Error("Composer image blob store is blocked.")),
    );
  }));
}

function completed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function withStore<A>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A> | void,
) {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  const request = use(transaction.objectStore(STORE_NAME));
  await completed(transaction);
  return request?.result;
}
