import type { ThreadMoveDialogCopy } from "./composerSend.logic";

type Pending = {
  readonly copy: ThreadMoveDialogCopy;
  readonly resolve: (confirmed: boolean) => void;
};

let pending: Pending | null = null;
const listeners = new Set<() => void>();

function publish(next: Pending | null): void {
  pending = next;
  for (const listener of listeners) listener();
}

export function readThreadMoveDialog(): ThreadMoveDialogCopy | null {
  return pending?.copy ?? null;
}

/** A subscriber is a mounted dialog. When the last one leaves, the question counts as declined. */
export function subscribeThreadMoveDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    answerThreadMoveDialog(false);
  };
}

/** Resolves false when no dialog is mounted. A new question declines the one before it. */
export function askThreadMove(copy: ThreadMoveDialogCopy): Promise<boolean> {
  if (listeners.size === 0) return Promise.resolve(false);
  pending?.resolve(false);
  return new Promise((resolve) => publish({ copy, resolve }));
}

export function answerThreadMoveDialog(confirmed: boolean): void {
  if (pending === null) return;
  pending.resolve(confirmed);
  publish(null);
}
