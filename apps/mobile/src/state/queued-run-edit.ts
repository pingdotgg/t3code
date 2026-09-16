/**
 * Editing a message that is already queued on the server.
 *
 * The composer is reused rather than duplicated, so the edit needs somewhere
 * to put its text that is not the user's own draft for the thread. It gets a
 * derived draft key: the thread's key plus a marker and the run id. That key
 * still ends in the thread id segment, so everything keyed off the draft key
 * (attachment uploads resolving an environment, per-draft persistence) keeps
 * working, while the user's draft is never touched and is waiting unchanged
 * when the edit is cancelled.
 *
 * The record below is in-memory only: an edit that does not survive a restart
 * is better than a composer that reopens pointed at a run the server may have
 * already started.
 */
import type {
  ChatAttachment,
  MessageId,
  OrchestrationMessageContext,
  RunId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { uploadedComposerContext } from "../lib/composerContext";
import { appAtomRegistry } from "./atom-registry";
import { queuedEditDraftKey } from "./queued-edit-draft-key";
import {
  clearComposerDraft,
  setComposerDraftContext,
  setComposerDraftText,
} from "./use-composer-drafts";

export interface QueuedRunEdit {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  /** Server attachments still attached; removing one drops it from this list. */
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
}

export const queuedRunEditsAtom = Atom.make<Readonly<Record<string, QueuedRunEdit>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-queued-run-edits"),
);

export { isQueuedEditDraftKey, queuedEditDraftKey } from "./queued-edit-draft-key";

export function getQueuedRunEdit(threadKey: string | null): QueuedRunEdit | null {
  if (threadKey === null) return null;
  return appAtomRegistry.get(queuedRunEditsAtom)[threadKey] ?? null;
}

export function useQueuedRunEdit(threadKey: string | null): QueuedRunEdit | null {
  const edits = useAtomValue(queuedRunEditsAtom);
  return threadKey === null ? null : (edits[threadKey] ?? null);
}

function setQueuedRunEdit(threadKey: string, edit: QueuedRunEdit | null): void {
  const current = appAtomRegistry.get(queuedRunEditsAtom);
  if (edit === null) {
    if (!current[threadKey]) return;
    const next = { ...current };
    delete next[threadKey];
    appAtomRegistry.set(queuedRunEditsAtom, next);
    return;
  }
  appAtomRegistry.set(queuedRunEditsAtom, { ...current, [threadKey]: edit });
}

/** Loads the queued message into its own draft and puts the composer in edit mode. */
export function beginQueuedRunEdit(threadKey: string, edit: QueuedRunEdit): void {
  const previous = getQueuedRunEdit(threadKey);
  if (previous !== null && previous.runId !== edit.runId) {
    clearComposerDraft(queuedEditDraftKey(threadKey, previous.runId));
  }
  const draftKey = queuedEditDraftKey(threadKey, edit.runId);
  clearComposerDraft(draftKey);
  setComposerDraftText(draftKey, edit.originalText);
  setComposerDraftContext(draftKey, edit.context);
  setQueuedRunEdit(threadKey, edit);
}

export function removeQueuedRunEditAttachment(threadKey: string, attachmentId: string): void {
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null) return;
  setQueuedRunEdit(threadKey, {
    ...edit,
    existingAttachments: edit.existingAttachments.filter(
      (attachment) => attachment.id !== attachmentId,
    ),
  });
}

export function endQueuedRunEdit(
  threadKey: string,
  options?: { readonly deferAttachmentCleanup?: boolean },
): void {
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null) return;
  clearComposerDraft(queuedEditDraftKey(threadKey, edit.runId), options);
  setQueuedRunEdit(threadKey, null);
}

/**
 * The replacement payload for `queued-run.edit`. Attachments replace the
 * message's list wholesale, so kept server attachments are resent alongside
 * the newly uploaded ones, in composer order. Context records are rebound to
 * the uploaded ids and then pruned to what the final list still contains, so
 * removing an attachment cannot leave a record pointing at nothing.
 */
export function resolveQueuedEditPayload(input: {
  readonly edit: QueuedRunEdit;
  readonly draftContext: OrchestrationMessageContext | undefined;
  readonly draftAttachments: ReadonlyArray<{ readonly id: string }>;
  readonly uploaded: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
}): {
  readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
  readonly context: OrchestrationMessageContext | undefined;
} {
  const attachments = [...input.edit.existingAttachments, ...input.uploaded];
  const rebound = uploadedComposerContext(
    input.draftContext,
    input.draftAttachments,
    input.uploaded,
  );
  if (rebound === undefined) return { attachments, context: undefined };
  const liveIds = new Set(
    attachments.flatMap((attachment) =>
      "id" in attachment && attachment.id ? [attachment.id] : [],
    ),
  );
  const records = rebound.records.filter(
    (record) => !("attachmentId" in record) || liveIds.has(record.attachmentId),
  );
  return {
    attachments,
    context: records.length > 0 ? { version: 1, records } : undefined,
  };
}
