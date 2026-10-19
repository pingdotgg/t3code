import {
  replaceComposerContextReferences,
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { randomUUID } from "../../lib/utils";
import {
  queuedEditDraftMatchesSource,
  queuedEditDraftHasMissingAttachments,
  type QueuedRunEditDraft,
} from "@t3tools/client-runtime/state/queued-run-edit-draft";
import type {
  ChatAttachment,
  ChatImageAttachment,
  ChatFileAttachment,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  composerDraftHasUserContent,
  createEmptyThreadDraft,
  resolveComposerDraftKey,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerThreadTarget,
  type ComposerThreadDraftState,
} from "../../composerDraftStore";

export async function prepareQueuedMessageEditDraft(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly edit: Pick<QueuedRunEditDraft, "runId" | "messageId" | "context"> &
    NonNullable<QueuedRunEditDraft["ownership"]>;
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly readImage: (attachment: ChatAttachment) => Promise<{ file: File; dataUrl: string }>;
}) {
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(input.editTarget);
  const key = resolveComposerDraftKey(store, input.editTarget);
  if (key === null) throw new Error("Queued edit draft unavailable.");
  const contextIds = new Map(
    (input.edit.context?.records ?? []).flatMap((record) =>
      "attachmentId" in record && (record.kind === "image" || record.kind === "file")
        ? [
            [
              record.contextId,
              toKindScopedComposerContextId(record.kind, record.attachmentId),
            ] as const,
          ]
        : [],
    ),
  );
  const text = replaceComposerContextReferences(input.text, (ref) => {
    const contextId = contextIds.get(ref.contextId);
    return contextId ? formatComposerContextReference({ ...ref, contextId }) : ref.source;
  });
  const context = input.edit.context && {
    version: 1 as const,
    records: input.edit.context.records.map((record) => ({
      ...record,
      contextId: contextIds.get(record.contextId) ?? record.contextId,
      ...("screenshotContextId" in record && record.screenshotContextId
        ? {
            screenshotContextId:
              contextIds.get(record.screenshotContextId) ?? record.screenshotContextId,
          }
        : {}),
    })),
  };
  const matches =
    queuedEditDraftMatchesSource(existing?.queuedEdit, input.text, input.attachments) &&
    existing?.queuedEdit !== undefined &&
    !queuedEditDraftHasMissingAttachments(existing.queuedEdit, [
      ...existing.images,
      ...existing.files,
    ]) &&
    existing.queuedEdit.context?.records.every(
      (record) =>
        !("attachmentId" in record) ||
        (record.kind !== "image" && record.kind !== "file") ||
        record.contextId === toKindScopedComposerContextId(record.kind, record.attachmentId),
    ) !== false;
  if (existing !== null && !matches) {
    const { queuedEdit, ...content } = existing;
    const retained = queuedEdit
      ? { ...content, queuedEdit: { ...queuedEdit, ownership: undefined } }
      : content;
    const next = { ...store.draftsByThreadKey };
    if (composerDraftHasUserContent(retained)) next[`${key}:saved:${randomUUID()}`] = retained;
    delete next[key];
    useComposerDraftStore.setState({ draftsByThreadKey: next });
  }
  if (matches && existing?.queuedEdit) {
    const queuedEdit = existing.queuedEdit;
    useComposerDraftStore.setState((state) => ({
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [key]: {
          ...existing,
          queuedEdit: {
            ...queuedEdit,
            ownership: { editId: input.edit.editId, sequence: input.edit.sequence },
          },
        },
      },
    }));
    return;
  }
  useComposerDraftStore.setState((state) => {
    const draft = state.draftsByThreadKey[key] ?? createEmptyThreadDraft();
    return {
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [key]: {
          ...draft,
          prompt: text,
          queuedEdit: {
            runId: input.edit.runId,
            messageId: input.edit.messageId,
            sourceText: input.text,
            originalText: text,
            originalAttachmentIds: input.attachments.map((attachment) => attachment.id),
            ...(context ? { context } : {}),
            ownership: { editId: input.edit.editId, sequence: input.edit.sequence },
          },
        },
      },
    };
  });
  const ownership = store.getComposerDraft(input.editTarget)?.queuedEdit?.ownership;
  const ownsDraft = () =>
    store.getComposerDraft(input.editTarget)?.queuedEdit?.ownership === ownership;
  if (
    input.attachments.some(
      (attachment) => attachment.type !== "image" && attachment.type !== "file",
    )
  )
    throw new Error("This attachment cannot be edited.");
  const images = await Promise.all(
    input.attachments
      .filter((attachment): attachment is ChatImageAttachment => attachment.type === "image")
      .map(async (image) => {
        const { file, dataUrl } = await input.readImage(image);
        return { ...image, file, previewUrl: dataUrl, dataUrl };
      }),
  );
  if (!ownsDraft()) return;
  store.addImages(input.editTarget, images, { allowDuplicates: true });
  await store.syncPersistedAttachments(input.editTarget, images);
  if (!ownsDraft()) return;
  store.addFiles(
    input.editTarget,
    input.attachments
      .filter((attachment): attachment is ChatFileAttachment => attachment.type === "file")
      .map((file) => ({
        ...file,
        file: null,
        uploadedAttachmentId: file.id,
        uploadEnvironmentId: input.environmentId,
      })),
    { allowDuplicates: true },
  );
}

export function releaseQueuedMessageEditDraft(editTarget: ComposerThreadTarget) {
  const store = useComposerDraftStore.getState();
  const key = resolveComposerDraftKey(store, editTarget);
  if (key === null) return;
  const draft = store.draftsByThreadKey[key];
  if (!draft?.queuedEdit) return;
  useComposerDraftStore.setState({
    draftsByThreadKey: {
      ...store.draftsByThreadKey,
      [key]: { ...draft, queuedEdit: { ...draft.queuedEdit, ownership: undefined } },
    },
  });
  store.setPrompt(editTarget, draft.prompt);
}

export function recoverQueuedMessageEdit(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly threadTarget: ComposerThreadTarget;
  readonly originalText: string;
  readonly originalAttachmentIds?: ReadonlyArray<string>;
  readonly expectedEdit?: Pick<QueuedRunEditDraft, "runId" | "ownership">;
}): "kept" | "retained" | "clean" {
  const store = useComposerDraftStore.getState();
  const currentEdit = store.getComposerDraft(input.editTarget)?.queuedEdit;
  if (
    input.expectedEdit &&
    (currentEdit?.runId !== input.expectedEdit.runId ||
      currentEdit?.ownership !== input.expectedEdit.ownership)
  )
    return "clean";
  releaseQueuedMessageEditDraft(input.editTarget);
  const draft = store.getComposerDraft(input.editTarget);
  const dirty =
    draft !== null &&
    (draft.prompt !== input.originalText ||
      (draft.queuedEdit?.removedAttachmentIds?.length ?? 0) > 0 ||
      [...draft.images, ...draft.files].some(
        (attachment) => !input.originalAttachmentIds?.includes(attachment.id),
      ) ||
      draft.terminalContexts.length > 0 ||
      draft.reviewComments.length > 0 ||
      draft.previewAnnotations.length > 0 ||
      draft.threadContexts.length > 0);
  if (!dirty || draft === null) {
    store.clearComposerContent(input.editTarget);
    return "clean";
  }
  const fromKey = resolveComposerDraftKey(store, input.editTarget);
  const toKey = resolveComposerDraftKey(store, input.threadTarget);
  if (fromKey === null || toKey === null || fromKey === toKey) return "kept";
  const destination = store.getComposerDraft(input.threadTarget);
  if (composerDraftHasUserContent(destination)) return "retained";
  const { queuedEdit: _queuedEdit, ...recovered } = draft;
  const next = { ...store.draftsByThreadKey, [toKey]: recovered };
  delete next[fromKey];
  useComposerDraftStore.setState({ draftsByThreadKey: next });
  return "kept";
}

export async function prepareQueuedEditPayload(input: {
  readonly edit: QueuedRunEditDraft;
  readonly content: {
    readonly [
      Key in
        | "images"
        | "files"
        | "terminalContexts"
        | "reviewComments"
        | "previewAnnotations"
        | "threadContexts"
    ]: Readonly<ComposerThreadDraftState[Key]>;
  };
  readonly uploadFiles: (
    files: ReadonlyArray<ComposerFileAttachment>,
  ) => Promise<ReadonlyArray<ChatAttachment>>;
  readonly readImage: (file: File) => Promise<string>;
}) {
  const { edit, content } = input;
  const drafts = [...content.images, ...content.files];
  if (queuedEditDraftHasMissingAttachments(edit, drafts))
    throw new Error(
      "An attachment could not be restored. Cancel and reopen the edit to restore it before saving.",
    );
  const files = content.files.length === 0 ? [] : await input.uploadFiles(content.files);
  if (files.length !== content.files.length)
    throw new Error("Retry or remove failed uploads before saving.");
  const images = await Promise.all(
    content.images.map(async (image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      ...(!edit.originalAttachmentIds.includes(image.id)
        ? { dataUrl: await input.readImage(image.file) }
        : {}),
      ...(image.source ? { source: image.source } : {}),
    })),
  );
  const uploaded = [...images, ...files];
  const originalOrder = new Map(edit.originalAttachmentIds.map((id, index) => [id, index]));
  const attachments = [...uploaded].sort(
    (left, right) =>
      (originalOrder.get(left.id) ?? originalOrder.size) -
      (originalOrder.get(right.id) ?? originalOrder.size),
  );
  const records = [
    ...(edit.context?.records ?? []).filter((record) => !("attachmentId" in record)),
    ...(buildMessageContext({
      ...content,
      terminalContexts: content.terminalContexts.filter(
        (context) => context.text.trim().length > 0,
      ),
      attachments: drafts.map((attachment, index) => ({
        attachment,
        attachmentId: uploaded[index]!.id,
      })),
    })?.records ?? []),
  ];
  return {
    attachments,
    context: {
      version: 1 as const,
      records: [...new Map(records.map((record) => [record.contextId, record])).values()],
    },
  };
}
