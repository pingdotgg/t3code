const DB_NAME = "t3-tool-work-log-summaries";
const STORE = "lines";
const DB_VERSION = 1;

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase | undefined> {
  if (!canUseIndexedDb()) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => {
      reject(req.error ?? new Error("indexedDB.open failed"));
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
  });
}

let dbPromise: Promise<IDBDatabase | undefined> | undefined;

function getDb(): Promise<IDBDatabase | undefined> {
  if (!canUseIndexedDb()) {
    return Promise.resolve(undefined);
  }
  if (dbPromise === undefined) {
    dbPromise = openDb().catch(() => undefined);
  }
  return dbPromise;
}

export async function readToolWorkLogSummaryCache(key: string): Promise<string | undefined> {
  try {
    const db = await getDb();
    if (!db) {
      return undefined;
    }
    return await new Promise<string | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const r = store.get(key);
      r.onsuccess = () => {
        const v = r.result;
        resolve(typeof v === "string" ? v : undefined);
      };
      r.onerror = () => {
        reject(r.error ?? new Error("idb get failed"));
      };
    });
  } catch {
    return undefined;
  }
}

export async function writeToolWorkLogSummaryCache(key: string, line: string): Promise<void> {
  try {
    const db = await getDb();
    if (!db) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const r = store.put(line, key);
      r.onsuccess = () => {
        resolve();
      };
      r.onerror = () => {
        reject(r.error ?? new Error("idb put failed"));
      };
    });
  } catch {
    /* ignore quota / private mode */
  }
}
