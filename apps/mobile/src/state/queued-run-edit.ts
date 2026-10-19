import {
  queuedEditDraftMatchesSource,
  queuedEditDraftHasMissingAttachments,
  type QueuedRunEditDraft,
} from "@t3tools/client-runtime/state/queued-run-edit-draft";
import { uuidv4 } from "../lib/uuid";
import { useMemo } from "react";
import type {
  ChatAttachment,
  CommandId,
  MessageId,
  OrchestrationMessageContext,
  RunId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { uploadedComposerContext } from "../lib/composerContext";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { appAtomRegistry } from "./atom-registry";
import { queuedEditDraftKey } from "./queued-edit-draft-key";
import {
  clearComposerDraft,
  updateComposerDrafts,
  setComposerDraftContext,
  setComposerDraftText,
  getComposerDraftSnapshot,
  composerDraftsAtom,
  isComposerDraftEmpty,
  appendComposerDraftAttachments,
} from "./use-composer-drafts";

export interface QueuedRunEdit {
  readonly editId: CommandId | null;
  readonly sequence: number;
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  readonly originalAttachmentIds: ReadonlyArray<string>;
  readonly context?: OrchestrationMessageContext;
}

export { queuedEditDraftKey } from "./queued-edit-draft-key";

const queuedEditRecoverySelectionAtom = Atom.make<Readonly<Record<string, string>>>({}).pipe(
  Atom.keepAlive,
);

export function selectQueuedEditRecovery(threadKey: string, draftKey: string | null): void {
  const next = { ...appAtomRegistry.get(queuedEditRecoverySelectionAtom) };
  if (draftKey === null) delete next[threadKey];
  else next[threadKey] = draftKey;
  appAtomRegistry.set(queuedEditRecoverySelectionAtom, next);
}

export function getQueuedEditRecovery(threadKey: string): string | null {
  const key = appAtomRegistry.get(queuedEditRecoverySelectionAtom)[threadKey];
  return key !== undefined && appAtomRegistry.get(composerDraftsAtom)[key] !== undefined
    ? key
    : null;
}

export function useQueuedEditRecovery(threadKey: string | null): string | null {
  const selections = useAtomValue(queuedEditRecoverySelectionAtom);
  const drafts = useSavedQueuedEditDrafts(threadKey);
  const selected = threadKey === null ? undefined : selections[threadKey];
  return selected !== undefined && drafts.includes(selected) ? selected : null;
}

const savedEditDraftsAtom = Atom.family((threadKey: string) =>
  Atom.make((get) =>
    Object.keys(get(composerDraftsAtom)).filter((key) =>
      key.startsWith(`${threadKey}~queued-edit~`),
    ),
  ).pipe(
    Atom.withEquality<ReadonlyArray<string>>(
      (left, right) =>
        left.length === right.length && left.every((key, index) => key === right[index]),
    ),
  ),
);

export function useSavedQueuedEditDrafts(threadKey: string | null) {
  return useAtomValue(savedEditDraftsAtom(threadKey ?? ""));
}

function activeEditDraft(
  drafts: Readonly<Record<string, { readonly queuedEdit?: QueuedRunEditDraft }>>,
  threadKey: string,
) {
  return (
    Object.entries(drafts).find(
      ([key, draft]) =>
        key.startsWith(`${threadKey}~queued-edit~`) && draft.queuedEdit?.ownership !== undefined,
    )?.[1].queuedEdit ?? null
  );
}

function editFromDraft(draft: QueuedRunEditDraft | null): QueuedRunEdit | null {
  return draft?.ownership ? { ...draft, ...draft.ownership } : null;
}

export function getQueuedRunEdit(threadKey: string | null): QueuedRunEdit | null {
  return threadKey === null
    ? null
    : editFromDraft(activeEditDraft(appAtomRegistry.get(composerDraftsAtom), threadKey));
}

const activeEditDraftAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => activeEditDraft(get(composerDraftsAtom), threadKey)),
);

export function useQueuedRunEdit(threadKey: string | null): QueuedRunEdit | null {
  const draft = useAtomValue(activeEditDraftAtom(threadKey ?? ""));
  return useMemo(() => editFromDraft(draft), [draft]);
}

export function forgetQueuedRunEdit(threadKey: string): void {
  updateComposerDrafts((current) => {
    const next = { ...current };
    for (const [key, draft] of Object.entries(current)) {
      if (!key.startsWith(threadKey + "~queued-edit~") || !draft.queuedEdit?.ownership) continue;
      const retained = { ...draft, queuedEdit: { ...draft.queuedEdit, ownership: undefined } };
      if (isComposerDraftEmpty(retained)) delete next[key];
      else next[key] = retained;
    }
    return next;
  });
}

export function canReuseQueuedRunEditDraft(
  threadKey: string,
  runId: RunId,
  text: string,
  attachments: ReadonlyArray<{ readonly id: string }>,
) {
  const draft = getComposerDraftSnapshot(queuedEditDraftKey(threadKey, runId));
  return (
    queuedEditDraftMatchesSource(draft.queuedEdit, text, attachments) &&
    draft.queuedEdit !== undefined &&
    !queuedEditDraftHasMissingAttachments(draft.queuedEdit, draft.attachments)
  );
}

export function beginQueuedRunEdit(
  threadKey: string,
  edit: QueuedRunEdit,
  attachments: ReadonlyArray<DraftComposerAttachment>,
): void {
  const previous = getQueuedRunEdit(threadKey);
  if (previous !== null && previous.runId !== edit.runId) {
    forgetQueuedRunEdit(threadKey);
  }
  selectQueuedEditRecovery(threadKey, null);
  const draftKey = queuedEditDraftKey(threadKey, edit.runId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[draftKey];
  const reuse = canReuseQueuedRunEditDraft(
    threadKey,
    edit.runId,
    edit.originalText,
    edit.originalAttachmentIds.map((id) => ({ id })),
  );
  if (existing && !reuse) {
    updateComposerDrafts((current) => {
      const retained = existing.queuedEdit
        ? { ...existing, queuedEdit: { ...existing.queuedEdit, ownership: undefined } }
        : existing;
      const next = { ...current };
      if (!isComposerDraftEmpty(retained)) next[`${draftKey}~saved~${uuidv4()}`] = retained;
      delete next[draftKey];
      return next;
    });
  }
  if (!reuse) {
    setComposerDraftText(draftKey, edit.originalText);
    setComposerDraftContext(draftKey, edit.context);
    appendComposerDraftAttachments(draftKey, attachments);
  }
  updateComposerDrafts((current) => {
    const draft = current[draftKey] ?? { text: "", attachments: [] };
    return {
      ...current,
      [draftKey]: {
        ...draft,
        queuedEdit: {
          runId: edit.runId,
          messageId: edit.messageId,
          sourceText: edit.originalText,
          originalText: reuse ? (existing?.queuedEdit?.originalText ?? draft.text) : draft.text,
          originalAttachmentIds: edit.originalAttachmentIds,
          ...(reuse && existing?.queuedEdit?.removedAttachmentIds
            ? { removedAttachmentIds: existing.queuedEdit.removedAttachmentIds }
            : {}),
          ...(edit.context ? { context: edit.context } : {}),
          ownership: { editId: edit.editId, sequence: edit.sequence },
        },
      },
    };
  });
}

export async function prepareQueuedRunEditDraft(
  threadKey: string,
  edit: QueuedRunEdit,
  readAttachments: () => Promise<ReadonlyArray<DraftComposerAttachment>>,
): Promise<void> {
  const reuse = canReuseQueuedRunEditDraft(
    threadKey,
    edit.runId,
    edit.originalText,
    edit.originalAttachmentIds.map((id) => ({ id })),
  );
  beginQueuedRunEdit(threadKey, edit, []);
  if (reuse) return;
  const draftKey = queuedEditDraftKey(threadKey, edit.runId);
  const ownership = getComposerDraftSnapshot(draftKey).queuedEdit?.ownership;
  const attachments = await readAttachments();
  if (getComposerDraftSnapshot(draftKey).queuedEdit?.ownership !== ownership) return;
  appendComposerDraftAttachments(draftKey, attachments, {
    allowOverflow: true,
  });
}

export function recoverQueuedRunEdit(
  threadKey: string,
  expectedEdit?: Pick<QueuedRunEditDraft, "runId" | "ownership">,
): boolean {
  const currentEdit = activeEditDraft(appAtomRegistry.get(composerDraftsAtom), threadKey);
  if (
    expectedEdit &&
    (currentEdit?.runId !== expectedEdit.runId || currentEdit?.ownership !== expectedEdit.ownership)
  )
    return false;
  const edit = editFromDraft(currentEdit);
  if (edit === null) return false;
  const draft = getComposerDraftSnapshot(queuedEditDraftKey(threadKey, edit.runId));
  const ids = edit.originalAttachmentIds ?? [];
  const dirty =
    draft.text !== edit.originalText ||
    (draft.queuedEdit?.removedAttachmentIds?.length ?? 0) > 0 ||
    draft.attachments.some((attachment) => !ids.includes(attachment.id));
  if (dirty) forgetQueuedRunEdit(threadKey);
  else endQueuedRunEdit(threadKey);
  return dirty;
}

export function endQueuedRunEdit(
  threadKey: string,
  options?: { readonly deferAttachmentCleanup?: boolean },
): void {
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null) return;
  clearComposerDraft(queuedEditDraftKey(threadKey, edit.runId), options);
}

/**
 * Attachments replace the message's list wholesale, so kept server attachments
 * are resent alongside the newly uploaded ones, in composer order.
 */
export function resolveQueuedEditPayload(input: {
  readonly draftContext: OrchestrationMessageContext | undefined;
  readonly draftAttachments: ReadonlyArray<{ readonly id: string }>;
  readonly uploaded: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
}): {
  readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
  readonly context: OrchestrationMessageContext | undefined;
} {
  const attachments = input.uploaded;
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
