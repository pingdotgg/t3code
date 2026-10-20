/**
 * That key still ends in the thread id segment, so everything keyed off the
 * draft key (attachment uploads resolving an environment, per-draft
 * persistence) keeps working, while the user's draft is never touched and is
 * waiting unchanged when the edit is cancelled.
 */
import type {
  ChatAttachment,
  MessageId,
  OrchestrationMessageContext,
  RunId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { uploadedComposerContext } from "../lib/composerContext";
import { appAtomRegistry } from "./atom-registry";
import { queuedEditDraftKey } from "./queued-edit-draft-key";
import {
  clearComposerDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  setComposerDraftContext,
  setComposerDraftText,
} from "./use-composer-drafts";

export interface QueuedRunEdit {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
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

export function recoverQueuedRunEdit(
  threadKey: string,
  runId: RunId,
): "kept" | "discarded" | "clean" | null {
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null || edit.runId !== runId) return null;
  const editDraft = getComposerDraftSnapshot(queuedEditDraftKey(threadKey, runId));
  const dirty = editDraft.text !== edit.originalText || editDraft.attachments.length > 0;
  if (!dirty) {
    // Untouched text was already sent; restoring it would duplicate the message.
    endQueuedRunEdit(threadKey);
    return "clean";
  }
  const threadDraft = getComposerDraftSnapshot(threadKey);
  const keepable =
    editDraft.text.trim().length > 0 &&
    threadDraft.text.trim().length === 0 &&
    threadDraft.attachments.length === 0;
  if (keepable) {
    void mergeComposerDraftContent(threadKey, {
      text: editDraft.text,
      attachments: editDraft.attachments,
      ...(editDraft.context ? { context: editDraft.context } : {}),
    });
  }
  endQueuedRunEdit(threadKey, { deferAttachmentCleanup: keepable });
  return keepable ? "kept" : "discarded";
}

/**
 * Attachments replace the message's list wholesale, so kept server attachments
 * are resent alongside the newly uploaded ones, in composer order.
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
