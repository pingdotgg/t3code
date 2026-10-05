import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atom-registry";

interface ThreadComposerError {
  readonly message: string;
  /** The queued message this error is about, when it is about one. */
  readonly messageId: string | null;
}

/**
 * Why a thread's last message did not go out, shown above that thread's
 * composer. The outbox drain can reject a message after the user has left the
 * thread, so the reason is kept per thread until they dismiss it, send again,
 * or the message it describes is delivered after all. Keyed by `scopedThreadKey`.
 */
export const threadComposerErrorsAtom = Atom.make<Readonly<Record<string, ThreadComposerError>>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-composer-errors"));

export function setThreadComposerError(
  threadKey: string,
  message: string,
  messageId: string | null = null,
): void {
  appAtomRegistry.set(threadComposerErrorsAtom, {
    ...appAtomRegistry.get(threadComposerErrorsAtom),
    [threadKey]: { message, messageId },
  });
}

/** With `messageId`, clears only an error that describes that message. */
export function clearThreadComposerError(threadKey: string, messageId?: string): void {
  const current = appAtomRegistry.get(threadComposerErrorsAtom);
  const error = current[threadKey];
  if (!error || (messageId !== undefined && error.messageId !== messageId)) {
    return;
  }
  const next = { ...current };
  delete next[threadKey];
  appAtomRegistry.set(threadComposerErrorsAtom, next);
}

export function clearThreadComposerErrorsForEnvironment(environmentId: string): void {
  const current = appAtomRegistry.get(threadComposerErrorsAtom);
  const prefix = `${environmentId}:`;
  const keys = Object.keys(current).filter((key) => key.startsWith(prefix));
  if (keys.length === 0) {
    return;
  }
  const next = { ...current };
  for (const key of keys) {
    delete next[key];
  }
  appAtomRegistry.set(threadComposerErrorsAtom, next);
}
