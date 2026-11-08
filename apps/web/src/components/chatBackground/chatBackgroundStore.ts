import type { ChatBackgroundEffect } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { ChatBackgroundWorkerRequest } from "./chatBackground.worker";

// Per browser on purpose: a remote client picks its own image, and nothing crosses the socket.
const DATABASE_NAME = "t3code:chat-background";
const STORE_NAME = "images";
const IMAGE_KEY = "current";
const CHAT_BACKGROUND_MAX_BYTES = 25 * 1024 * 1024;

let database: Promise<IDBDatabase> | undefined;
let image: Blob | null = null;
let loaded = false;
const listeners = new Set<() => void>();
const rendered = new Map<string, Promise<Blob>>();

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE_NAME));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  }));
}

async function withStore<A>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A>,
): Promise<A> {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  const request = use(transaction.objectStore(STORE_NAME));
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(request.result));
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

function publish(next: Blob | null) {
  image = next;
  loaded = true;
  rendered.clear();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loaded && typeof indexedDB !== "undefined") {
    loaded = true;
    withStore("readonly", (store) => store.get(IMAGE_KEY) as IDBRequest<Blob | undefined>).then(
      (stored) => {
        if (stored) publish(stored);
      },
      (error: unknown) => console.warn("Could not read the chat background.", error),
    );
  }
  return () => listeners.delete(listener);
}

function useChatBackgroundImage(): Blob | null {
  return useSyncExternalStore(
    subscribe,
    () => image,
    () => null,
  );
}

export async function setChatBackgroundImage(file: Blob) {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > CHAT_BACKGROUND_MAX_BYTES) throw new Error("Choose an image under 25 MB.");
  await withStore("readwrite", (store) => store.put(file, IMAGE_KEY));
  publish(file);
}

export async function removeChatBackgroundImage() {
  await withStore("readwrite", (store) => store.delete(IMAGE_KEY));
  publish(null);
}

function renderEffect(source: Blob, effect: ChatBackgroundEffect, light: boolean): Promise<Blob> {
  if (effect === "none") return Promise.resolve(source);
  const key = `${effect}:${light}`;
  let result = rendered.get(key);
  if (!result) {
    result = new Promise<Blob>((resolve, reject) => {
      const worker = new Worker(new URL("./chatBackground.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.addEventListener(
        "message",
        (event: MessageEvent<{ result?: Blob; error?: string }>) => {
          worker.terminate();
          if (event.data.result) resolve(event.data.result);
          else reject(new Error(event.data.error ?? "The background effect failed."));
        },
      );
      worker.addEventListener("error", (event) => {
        worker.terminate();
        reject(new Error(event.message));
      });
      worker.postMessage({ image: source, effect, light } satisfies ChatBackgroundWorkerRequest);
    });
    rendered.set(key, result);
    result.catch(() => rendered.delete(key));
  }
  return result;
}

/** An object URL for the stored image with `effect` applied, or null while none is ready. */
export function useChatBackgroundUrl(effect: ChatBackgroundEffect, light: boolean): string | null {
  const source = useChatBackgroundImage();
  const [url, setUrl] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- renders the effect off-thread in a worker and owns the resulting object URL
  useEffect(() => {
    if (!source) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    renderEffect(source, effect, light)
      .catch(() => source)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, effect, light]);
  return source ? url : null;
}
