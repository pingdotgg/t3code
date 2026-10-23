import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";

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
export function questionAttachmentCapacity(
  drafts: Readonly<Record<string, { readonly attachments: ReadonlyArray<unknown> }>>,
  prefix: string,
  key: string,
): number | undefined {
  const requestOf = (draftKey: string) =>
    draftKey.startsWith(prefix)
      ? (JSON.parse(decodeURIComponent(draftKey.slice(prefix.length))) as [string, string])[0]
      : null;
  const requestId = requestOf(key);
  if (requestId === null) return undefined;
  const otherCount = Object.entries(drafts).reduce(
    (count, [draftKey, draft]) =>
      draftKey !== key && requestOf(draftKey) === requestId
        ? count + draft.attachments.length
        : count,
    0,
  );
  return Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - otherCount);
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
