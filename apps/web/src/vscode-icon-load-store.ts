export type VscodeIconLoadStatus = "loading" | "loaded" | "error";

const iconLoadStatusByUrl = new Map<string, Exclude<VscodeIconLoadStatus, "loading">>();
const listenersByUrl = new Map<string, Set<() => void>>();

export function getVscodeIconLoadStatus(url: string): VscodeIconLoadStatus {
  return iconLoadStatusByUrl.get(url) ?? "loading";
}

export function subscribeVscodeIconLoadStatus(url: string, listener: () => void): () => void {
  let listeners = listenersByUrl.get(url);
  if (!listeners) {
    listeners = new Set();
    listenersByUrl.set(url, listeners);
  }
  listeners.add(listener);

  return () => {
    const currentListeners = listenersByUrl.get(url);
    if (!currentListeners) return;
    currentListeners.delete(listener);
    if (currentListeners.size === 0) {
      listenersByUrl.delete(url);
    }
  };
}

export function markVscodeIconLoaded(url: string): void {
  setVscodeIconLoadStatus(url, "loaded");
}

export function markVscodeIconFailed(url: string): void {
  setVscodeIconLoadStatus(url, "error");
}

export function __resetVscodeIconLoadStoreForTests(): void {
  iconLoadStatusByUrl.clear();
  listenersByUrl.clear();
}

function setVscodeIconLoadStatus(url: string, status: Exclude<VscodeIconLoadStatus, "loading">) {
  if (iconLoadStatusByUrl.get(url) === status) return;
  iconLoadStatusByUrl.set(url, status);
  const listeners = listenersByUrl.get(url);
  if (!listeners) return;
  const pendingListeners = Array.from(listeners);
  for (const listener of pendingListeners) {
    listener();
  }
}
