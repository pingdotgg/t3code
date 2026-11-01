import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";

interface ThreadComposerError {
  readonly message: string;
  readonly messageId: string | null;
}

/** Draining can fail after navigation away; retain errors per thread until dismissed, retried, or delivered. */
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
