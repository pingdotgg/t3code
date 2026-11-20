import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";
import { startComposerDraftOperation } from "./composerDraftOperations";
import { appendComposerDraftAttachments, getComposerDraftSnapshot } from "./use-composer-drafts";

export function questionAttachmentDraftPrefix(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string {
  return `${environmentId}:question-${encodeURIComponent(JSON.stringify(threadId))}-`;
}
export function questionAttachmentDraftKey(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: string,
  questionId: string,
): string {
  return `${questionAttachmentDraftPrefix(environmentId, threadId)}${encodeURIComponent(JSON.stringify([requestId, questionId]))}`;
}
export const questionAttachmentPreparationAtom = Atom.make<Record<string, number>>({}).pipe(
  Atom.keepAlive,
);
export function changeQuestionAttachmentPreparation(key: string, delta: number): void {
  const counts = appAtomRegistry.get(questionAttachmentPreparationAtom);
  if (delta < 0 && !(key in counts)) return;
  appAtomRegistry.set(questionAttachmentPreparationAtom, {
    ...counts,
    [key]: Math.max(0, (counts[key] ?? 0) + delta),
  });
}

const imagePreparations = new Map<string, Set<(threadKey: string | null) => void>>();

/** A paste can outlive its question and finish in the thread draft. */
export function startQuestionImagePreparation(key: string) {
  let destination: string | null = key;
  let threadOperation: ReturnType<typeof startComposerDraftOperation> | undefined;
  const resolve = (threadKey: string | null) => {
    destination = threadKey;
    if (threadKey !== null) threadOperation = startComposerDraftOperation(threadKey);
  };
  const pending = imagePreparations.get(key) ?? new Set();
  pending.add(resolve);
  imagePreparations.set(key, pending);
  changeQuestionAttachmentPreparation(key, 1);
  return {
    destination: () => (threadOperation?.signal.aborted ? null : destination),
    finish: () => {
      threadOperation?.finish();
      if (imagePreparations.get(key) !== pending || !pending.delete(resolve)) return;
      if (pending.size === 0) imagePreparations.delete(key);
      changeQuestionAttachmentPreparation(key, -1);
    },
  };
}

export function resolveQuestionImagePreparations(key: string, threadKey: string | null): void {
  const pending = imagePreparations.get(key);
  imagePreparations.delete(key);
  for (const resolve of pending ?? []) resolve(threadKey);
}

export function appendUnsentQuestionAttachments(
  threadKey: string,
  attachments: Parameters<typeof appendComposerDraftAttachments>[1],
): number {
  const { text } = getComposerDraftSnapshot(threadKey);
  // Chips go after the draft's text, never over a selection the user left in it.
  return appendComposerDraftAttachments(threadKey, attachments, {
    appendReference: true,
    insertion: { text, start: text.length, end: text.length },
  });
}
