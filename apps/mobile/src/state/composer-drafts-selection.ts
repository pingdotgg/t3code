import { useAtomValue } from "@effect/atom-react";
import {
  COMPOSER_CONTEXT_MAX_RECORDS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { createComposerContextHistory, referencedComposerContext } from "../lib/composerContext";
import { retainComposerAttachmentFileForPreview } from "../lib/composerAttachmentPreviewRetention";
import type { DraftComposerAttachment, FileBackedComposerAttachment } from "../lib/composerImages";
import { appAtomRegistry } from "./atom-registry";
import { getComposerDraftSnapshot, normalizeDraft, type ComposerDraft } from "./composer-drafts-model";
import { scheduleUnusedComposerAttachmentCleanup } from "./composer-drafts-attachments";
import { updateComposerDrafts } from "./composer-drafts-persistence";

export const composerContextImportsAtom = Atom.make<Record<string, boolean>>({}).pipe(
  Atom.keepAlive,
);

export function setComposerContextImporting(draftKey: string, importing: boolean): void {
  const next = { ...appAtomRegistry.get(composerContextImportsAtom) };
  if (importing) next[draftKey] = true;
  else delete next[draftKey];
  appAtomRegistry.set(composerContextImportsAtom, next);
}

interface ComposerDraftSelection {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

// Keyed by draft so a caret move in one composer neither replaces another draft's caret
// nor notifies its readers. Kept alive so the caret survives the composer unmounting.
const composerDraftSelectionAtom = Atom.family((_draftKey: string) =>
  Atom.make<ComposerDraftSelection | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:composer-draft-selection"),
  ),
);
const NO_COMPOSER_DRAFT_SELECTION_ATOM = Atom.make<ComposerDraftSelection | null>(null);

export function rememberComposerDraftSelection(
  draftKey: string,
  text: string,
  selection: { start: number; end: number },
): void {
  appAtomRegistry.set(composerDraftSelectionAtom(draftKey), { text, ...selection });
}

function matchingComposerDraftSelection(
  selection: ComposerDraftSelection | null,
  text: string,
): { start: number; end: number } | null {
  if (selection?.text !== text) return null;
  return { start: selection.start, end: selection.end };
}

/** Read the post-chip-insertion selection or the editor restores the pre-insert caret before the chip. */
function readComposerDraftSelection(
  draftKey: string,
  text: string,
): { start: number; end: number } | null {
  return matchingComposerDraftSelection(
    appAtomRegistry.get(composerDraftSelectionAtom(draftKey)),
    text,
  );
}

export function useComposerDraftSelection(
  draftKey: string | null,
  text: string,
): { start: number; end: number } | null {
  const selection = useAtomValue(
    draftKey === null ? NO_COMPOSER_DRAFT_SELECTION_ATOM : composerDraftSelectionAtom(draftKey),
  );
  return draftKey === null ? null : matchingComposerDraftSelection(selection, text);
}

export interface ComposerDraftInsertion {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function captureComposerDraftInsertion(
  draftKey: string,
  selection?: { start: number; end: number },
): ComposerDraftInsertion {
  const { text } = getComposerDraftSnapshot(draftKey);
  return {
    text,
    ...(selection ??
      readComposerDraftSelection(draftKey, text) ?? { start: text.length, end: text.length }),
  };
}

export function contextInsertionRange(
  draftKey: string,
  draft: ComposerDraft,
  target?: ComposerDraftInsertion,
) {
  const captured = target ?? appAtomRegistry.get(composerDraftSelectionAtom(draftKey));
  // Append after text edits during writes; caret-only moves preserve the captured insertion range.
  const selection = captured?.text === draft.text ? captured : null;
  const start = Math.max(0, Math.min(selection?.start ?? draft.text.length, draft.text.length));
  return { start, end: Math.max(start, Math.min(selection?.end ?? start, draft.text.length)) };
}

export function draftWithoutInsertionSelection(
  draftKey: string,
  draft: ComposerDraft,
  target?: ComposerDraftInsertion,
) {
  const { start, end } = contextInsertionRange(draftKey, draft, target);
  const text = `${draft.text.slice(0, start)} ${draft.text.slice(end)}`;
  return withReferencedContextFiles(draft, text, referencedComposerContext(text, draft.context));
}

export function countComposerDraftAttachmentsAfterSelection(
  draftKey: string,
  target: ComposerDraftInsertion,
): number {
  return getComposerDraftAfterSelection(draftKey, target).attachments.length;
}

export function getComposerDraftAfterSelection(
  draftKey: string,
  target: ComposerDraftInsertion,
): ComposerDraft {
  return draftWithoutInsertionSelection(draftKey, getComposerDraftSnapshot(draftKey), target);
}

export function withReferencedContextFiles(
  draft: ComposerDraft,
  text: string,
  context: OrchestrationMessageContext | undefined,
): ComposerDraft {
  const previousIds = new Set(
    draft.context?.records.flatMap((record) =>
      "attachmentId" in record ? [record.attachmentId] : [],
    ),
  );
  const retainedIds = new Set(
    context?.records.flatMap((record) => ("attachmentId" in record ? [record.attachmentId] : [])),
  );
  const attachments = draft.attachments.filter(
    (attachment) =>
      attachment.type === "image" ||
      !previousIds.has(attachment.id) ||
      retainedIds.has(attachment.id),
  );
  // Keep the array identity on plain text edits so attachment readers see no change.
  return {
    ...draft,
    text,
    context,
    attachments: attachments.length === draft.attachments.length ? draft.attachments : attachments,
  };
}

/** Retains file bytes while native text undo can restore their references. */
export function createComposerDraftContextHistory() {
  const restoreContext = createComposerContextHistory();
  const files = new Map<
    string,
    { attachment: FileBackedComposerAttachment; release: () => void }
  >();
  return {
    restore(text: string, draft: ComposerDraft) {
      for (const attachment of draft.attachments) {
        if (attachment.type !== "file") continue;
        const previous = files.get(attachment.id);
        files.delete(attachment.id);
        if (previous?.attachment.fileUri === attachment.fileUri) {
          previous.attachment = attachment;
          files.set(attachment.id, previous);
        } else {
          previous?.release();
          files.set(attachment.id, {
            attachment,
            release: retainComposerAttachmentFileForPreview(attachment),
          });
        }
      }
      const limit = Math.max(COMPOSER_CONTEXT_MAX_RECORDS, draft.attachments.length);
      while (files.size > limit) {
        const oldest = files.keys().next().value!;
        files.get(oldest)!.release();
        files.delete(oldest);
      }
      const context = restoreContext(text, draft.context);
      const liveIds = new Set(draft.attachments.map((attachment) => attachment.id));
      const attachments = (context?.records ?? []).flatMap((record) => {
        if (
          record.kind !== "file" ||
          !("attachmentId" in record) ||
          liveIds.has(record.attachmentId)
        )
          return [];
        const saved = files.get(record.attachmentId)?.attachment;
        liveIds.add(record.attachmentId);
        return saved
          ? [{ ...saved, uploadedAttachmentId: undefined, uploadEnvironmentId: undefined }]
          : [];
      });
      return { context, attachments };
    },
    dispose() {
      for (const file of files.values()) file.release();
      files.clear();
    },
  };
}

export function setComposerDraftContext(
  draftKey: string,
  context: OrchestrationMessageContext | undefined,
): void {
  updateComposerDrafts((current) => ({
    ...current,
    [draftKey]: { ...normalizeDraft(current[draftKey]), context },
  }));
}

export function insertComposerDraftContext(
  draftKey: string,
  content: {
    text: string;
    context: OrchestrationMessageContext;
    attachments?: ReadonlyArray<DraftComposerAttachment>;
  },
  target?: ComposerDraftInsertion,
): boolean {
  let inserted = false;
  let removed: ReadonlyArray<DraftComposerAttachment> = [];
  updateComposerDrafts((current) => {
    const draft = normalizeDraft(current[draftKey]);
    const attachments = content.attachments ?? [];
    const retained = draftWithoutInsertionSelection(draftKey, draft, target);
    if (
      attachments.length > 0 &&
      retained.attachments.length + attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    )
      return current;
    const nextDraft = draftWithInsertedContext(
      draftKey,
      { ...draft, attachments: [...draft.attachments, ...attachments] },
      content,
      target,
    );
    if (!nextDraft) return current;
    inserted = true;
    removed = draft.attachments.filter((attachment) => !nextDraft.attachments.includes(attachment));
    return { ...current, [draftKey]: nextDraft };
  });
  scheduleUnusedComposerAttachmentCleanup(inserted ? removed : (content.attachments ?? []));
  return inserted;
}

export function draftWithInsertedContext(
  draftKey: string,
  draft: ComposerDraft,
  content: { text: string; context: OrchestrationMessageContext },
  target?: ComposerDraftInsertion,
): ComposerDraft | null {
  const { start, end } = contextInsertionRange(draftKey, draft, target);
  const before = draft.text.slice(0, start);
  const after = draft.text.slice(end);
  const insertion = `${before.length > 0 && !/\s$/.test(before) && !/^\s/.test(content.text) ? " " : ""}${content.text}${!/\s$/.test(content.text) && (after.length === 0 || !/^\s/.test(after)) ? " " : ""}`;
  const text = before + insertion + after;
  const records = new Map(draft.context?.records.map((record) => [record.contextId, record]));
  for (const record of content.context.records) records.set(record.contextId, record);
  const context = referencedComposerContext(text, { version: 1, records: [...records.values()] });
  if ((context?.records.length ?? 0) > COMPOSER_CONTEXT_MAX_RECORDS) return null;
  rememberComposerDraftSelection(draftKey, text, {
    start: start + insertion.length,
    end: start + insertion.length,
  });
  return withReferencedContextFiles(draft, text, context);
}
