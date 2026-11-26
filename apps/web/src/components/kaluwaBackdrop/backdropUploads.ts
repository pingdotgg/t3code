// Fork: images uploaded for Kaluwa's backdrop. They are downscaled in the client and kept in
// this client's IndexedDB; they are never sent to a server.
import { useSyncExternalStore } from "react";

import { randomUUID } from "~/lib/utils";
import { downscaledSize } from "./backdropMath";

export interface BackdropUpload {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly blob: Blob;
  readonly createdAt: number;
}

const DB_NAME = "t3code-kaluwa-backdrop";
const STORE = "uploads";
const MAX_SIDE = 960;
const FALLBACK_SIDE = 640;
const MAX_BYTES = 900_000;

type Snapshot = { readonly ready: boolean; readonly uploads: ReadonlyArray<BackdropUpload> };

let snapshot: Snapshot = { ready: false, uploads: [] };
let loadStarted = false;
const listeners = new Set<() => void>();
const bitmaps = new Map<string, Promise<ImageBitmap>>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

function ensureLoaded() {
  if (loadStarted || typeof indexedDB === "undefined") return;
  loadStarted = true;
  void withStore<BackdropUpload[]>("readonly", (store) => store.getAll())
    .then((uploads) =>
      publish({ ready: true, uploads: uploads.toSorted((a, b) => a.createdAt - b.createdAt) }),
    )
    .catch((error: unknown) => {
      console.error("[kaluwa-backdrop] Could not read uploaded images.", error);
      publish({ ready: true, uploads: [] });
    });
}

function subscribe(listener: () => void) {
  ensureLoaded();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;

export function useBackdropUploads(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Decoded bitmap of an upload, shared by every canvas that draws it. */
export function uploadBitmap(upload: BackdropUpload): Promise<ImageBitmap> {
  let bitmap = bitmaps.get(upload.id);
  if (!bitmap) {
    bitmap = createImageBitmap(upload.blob);
    bitmaps.set(upload.id, bitmap);
  }
  return bitmap;
}

async function encode(source: ImageBitmap, maxSide: number, quality: number) {
  const size = downscaledSize(source.width, source.height, maxSide);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, size.width, size.height);
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, size.width, size.height);
  return { ...size, blob: await canvas.convertToBlob({ type: "image/jpeg", quality }) };
}

export const isImageFile = (file: File) => file.type.startsWith("image/");

/** Downscales an image file and stores it. Rejects when the file cannot be decoded. */
export async function addBackdropUpload(file: File): Promise<BackdropUpload> {
  const source = await createImageBitmap(file);
  let encoded = await encode(source, MAX_SIDE, 0.84);
  if (encoded.blob.size > MAX_BYTES) encoded = await encode(source, FALLBACK_SIDE, 0.72);
  source.close();
  const upload: BackdropUpload = {
    id: randomUUID(),
    name: file.name.replace(/\.[^.]+$/, "").slice(0, 28) || "Image",
    width: encoded.width,
    height: encoded.height,
    blob: encoded.blob,
    createdAt: Date.now(),
  };
  await withStore("readwrite", (store) => store.put(upload));
  publish({ ready: true, uploads: [...snapshot.uploads, upload] });
  return upload;
}

export async function removeBackdropUpload(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
  void bitmaps.get(id)?.then((bitmap) => bitmap.close());
  bitmaps.delete(id);
  publish({ ...snapshot, uploads: snapshot.uploads.filter((upload) => upload.id !== id) });
}
