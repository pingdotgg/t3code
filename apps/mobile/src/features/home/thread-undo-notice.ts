import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { useSyncExternalStore } from "react";

type UndoNotice = {
  readonly action: "Settled" | "Snoozed" | "Unpinned";
  readonly claim: ReturnType<typeof ThreadUndo.begin>;
  readonly undo: () => Promise<void>;
  /** Threads the undo would restore; a group action counts every member. */
  readonly count?: () => number;
};

export function threadUndoNoticeMessage(notice: UndoNotice): string {
  const count = notice.count?.() ?? 1;
  return count > 1 ? `${notice.action} ${count} threads` : `${notice.action} thread`;
}

let notice: UndoNotice | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function readThreadUndoNotice() {
  return notice;
}

export function dismissThreadUndoNotice() {
  const previous = notice;
  notice = null;
  clearTimeout(expiry);
  previous?.claim.finish();
  notify();
}

ThreadUndo.subscribe(() => {
  if (notice !== null && !notice.claim.isCurrent()) dismissThreadUndoNotice();
});

export function showThreadUndoNotice(options: UndoNotice) {
  if (!options.claim.isCurrent()) return;
  dismissThreadUndoNotice();
  notice = {
    ...options,
    undo: async () => {
      if (notice?.claim !== options.claim || !options.claim.isCurrent()) return;
      dismissThreadUndoNotice();
      await options.undo();
    },
  };
  notify();
  expiry = setTimeout(dismissThreadUndoNotice, 5_000);
}

export function useThreadUndoNotice() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, readThreadUndoNotice);
}
