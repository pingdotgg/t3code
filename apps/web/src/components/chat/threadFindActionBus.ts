const THREAD_FIND_OPEN_EVENT = "t3:thread-find-open";

export function requestThreadFindOpen(): void {
  window.dispatchEvent(new Event(THREAD_FIND_OPEN_EVENT));
}

export function subscribeThreadFindOpen(listener: () => void): () => void {
  window.addEventListener(THREAD_FIND_OPEN_EVENT, listener);
  return () => window.removeEventListener(THREAD_FIND_OPEN_EVENT, listener);
}
