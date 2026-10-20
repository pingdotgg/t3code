const THREAD_RENAME_START_EVENT = "t3:thread-rename-start";

export function requestThreadRenameStart(): void {
  window.dispatchEvent(new Event(THREAD_RENAME_START_EVENT));
}

export function subscribeThreadRenameStart(listener: () => void): () => void {
  window.addEventListener(THREAD_RENAME_START_EVENT, listener);
  return () => window.removeEventListener(THREAD_RENAME_START_EVENT, listener);
}
