import { useSyncExternalStore } from "react";

export type ComposerInsertNotice = {
  readonly environmentId: string;
  readonly threadId: string;
};

let notice: ComposerInsertNotice | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function dismissComposerInsertNotice() {
  notice = null;
  clearTimeout(expiry);
  notify();
}

export function showComposerInsertNotice(next: ComposerInsertNotice) {
  notice = next;
  clearTimeout(expiry);
  notify();
  expiry = setTimeout(dismissComposerInsertNotice, 4_000);
}

export function useComposerInsertNotice() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => notice,
  );
}
