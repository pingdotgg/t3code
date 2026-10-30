import type {
  ChatAttachment,
  MessageId,
  OrchestrationMessageContext,
  RunId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import {
  makeQueuedRunEditStore,
  resolveQueuedEditExit,
  type QueuedRunsAtom,
} from "@t3tools/client-runtime/queued-run-edit";

import { uploadedComposerContext } from "../lib/composerContext";
import { appAtomRegistry } from "./atom-registry";
import { abortComposerDraftOperations } from "./composerDraftOperations";
import { queuedEditDraftKey } from "./queued-edit-draft-key";
import { setThreadComposerError } from "./thread-composer-error";
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
  /** Removing a server attachment changes the message even when the draft looks untouched. */
  readonly removedExistingAttachment?: true;
}

const queuedRunEdits = makeQueuedRunEditStore<QueuedRunEdit>({
  registry: appAtomRegistry,
  label: "mobile-queued-run-edits",
});

export { queuedEditDraftKey } from "./queued-edit-draft-key";

export const getQueuedRunEdit = queuedRunEdits.get;

/**
 * The draft a sheet opened for `requestedKey` should edit now: a queued edit's
 * draft only while that edit is still open, else the thread's own draft.
 */
export function activeComposerDraftKey(
  threadKey: string,
  requestedKey: string,
  edit: QueuedRunEdit | null,
): string {
  if (requestedKey === threadKey) return threadKey;
  return edit !== null && queuedEditDraftKey(threadKey, edit.runId) === requestedKey
    ? requestedKey
    : threadKey;
}

export function useQueuedRunEdit(threadKey: string | null): QueuedRunEdit | null {
  const edits = useAtomValue(queuedRunEdits.atom);
  return threadKey === null ? null : (edits[threadKey] ?? null);
}

/**
 * The run started or was cancelled elsewhere. A changed edit goes back into
 * the thread's composer when that is empty; otherwise it is dropped. Either
 * way the thread says so, wherever the user is when it happens.
 */
function exitQueuedRunEdit(threadKey: string, edit: QueuedRunEdit): void {
  const editDraftKey = queuedEditDraftKey(threadKey, edit.runId);
  const editDraft = getComposerDraftSnapshot(editDraftKey);
  const threadDraft = getComposerDraftSnapshot(threadKey);
  const editRestorable = editDraft.text.trim().length > 0 || editDraft.attachments.length > 0;
  const recovery = resolveQueuedEditExit({
    editChanged:
      editDraft.text !== edit.originalText ||
      editDraft.attachments.length > 0 ||
      edit.removedExistingAttachment === true,
    // A cleared edit has nothing to put back, so it can only be discarded.
    threadDraftEmpty:
      editRestorable &&
      threadDraft.text.trim().length === 0 &&
      threadDraft.attachments.length === 0,
  });
  if (recovery === "kept") {
    // The merge publishes the draft before writing it, so a failed write only delays persistence to the next one.
    mergeComposerDraftContent(threadKey, {
      text: editDraft.text,
      attachments: editDraft.attachments,
      ...(editDraft.context ? { context: editDraft.context } : {}),
    }).catch((error: unknown) => {
      console.warn("[queued-run-edit] could not persist the recovered edit", error);
    });
  }
  clearComposerDraft(editDraftKey, { deferAttachmentCleanup: recovery === "kept" });
  if (recovery === "clean") return;
  setThreadComposerError(
    threadKey,
    recovery === "kept"
      ? "That message already started. Your edit is back in the composer."
      : "That message already started, so the edit was discarded.",
  );
}

/** `runs` is the thread's runs; the edit ends when its run leaves the queue. */
export function beginQueuedRunEdit(
  threadKey: string,
  edit: QueuedRunEdit,
  runs: QueuedRunsAtom,
): void {
  const previous = getQueuedRunEdit(threadKey);
  if (previous !== null && previous.runId !== edit.runId) {
    clearComposerDraft(queuedEditDraftKey(threadKey, previous.runId));
  }
  // The composer moves off the thread draft, so a paste or pick still running for it is dropped.
  abortComposerDraftOperations(threadKey);
  const draftKey = queuedEditDraftKey(threadKey, edit.runId);
  const originalText = isAttachmentOnlyBootstrapPrompt(edit.originalText) ? "" : edit.originalText;
  clearComposerDraft(draftKey);
  setComposerDraftText(draftKey, originalText);
  setComposerDraftContext(draftKey, edit.context);
  queuedRunEdits.begin(
    threadKey,
    { ...edit, originalText },
    { runs, onRunLeftQueue: exitQueuedRunEdit },
  );
}

export function removeQueuedRunEditAttachment(threadKey: string, attachmentId: string): void {
  queuedRunEdits.update(threadKey, (edit) => ({
    ...edit,
    removedExistingAttachment: true,
    existingAttachments: edit.existingAttachments.filter(
      (attachment) => attachment.id !== attachmentId,
    ),
  }));
}

export function endQueuedRunEdit(
  threadKey: string,
  options?: { readonly deferAttachmentCleanup?: boolean },
): void {
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null) return;
  clearComposerDraft(queuedEditDraftKey(threadKey, edit.runId), options);
  queuedRunEdits.end(threadKey);
}

/**
 * Claims the open edit for a save; while it runs, the save's result decides the
 * edit's fate. Null when there is no edit or a save is already in flight.
 */
export const startQueuedRunEditSave = queuedRunEdits.startSave;

/** Attachments replace wholesale; resend kept server attachments with uploads in composer order. */
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
