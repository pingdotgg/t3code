import { msg } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { useAtomValue } from "@effect/atom-react";
import {
  makeQueuedRunEditStore,
  makeQueuedRunsAtom,
} from "@t3tools/client-runtime/queued-run-edit";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatAttachment,
  type ComposerContextRecord,
  type EnvironmentContextRecord,
  type ResponseContextRecord,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type OrchestrationMessageContext,
  type PreviewAnnotationPayload,
  type ProjectKnowledgeContextRecord,
  type RunId,
  type ScopedThreadRef,
  type ThreadContextRecord,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  restoreAttachmentOnlyBootstrapPrompt,
  stripAttachmentOnlyBootstrapPrompt,
} from "@t3tools/shared/composerContextReferences";
import { Atom } from "effect/reactivity";
import type { RefObject } from "react";
import { useAssetUrls } from "../../assets/assetUrls";
import {
  queuedRunEditDraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  refreshExpiredAttachmentUploads,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { buildMessageContext, isResponseContextRecord } from "../../lib/composerContextRecords";
import {
  collectInlineContextIds,
  removeInlineContextReference,
} from "../../lib/composerContextReferences";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ComposerSubmissionIntent } from "../../composer-logic";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ChatComposerHandle } from "./ChatComposer";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { composerDraftContentChanged } from "./composerSend.logic";
import {
  attachmentContextIdsForRecord,
  discardQueuedEditDraft,
  prepareQueuedEditAttachments,
  recoverQueuedMessageEdit,
} from "./queuedMessageEdit";
import type { EditQueuedRunRequest } from "./QueuedRunsControl";

interface EditingQueuedRun {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  readonly originalModelSelection?: ModelSelection;
  readonly followsThreadSelection: boolean;
  readonly originalAttachments: ReadonlyArray<ChatAttachment>;
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}

// Keyed by the route thread, so an edit survives navigating away and back.
const queuedRunEdits = makeQueuedRunEditStore<EditingQueuedRun>({
  registry: appAtomRegistry,
  label: "web-queued-run-edits",
});

interface QueuedRunEditContent {
  readonly modelSelection: ModelSelection;
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly knowledgeContexts?: ReadonlyArray<ProjectKnowledgeContextRecord> | undefined;
  readonly environmentContexts: ReadonlyArray<EnvironmentContextRecord>;
  readonly replyTo?: ResponseContextRecord | null;
}

const isDraftOwnedRecord = (record: ComposerContextRecord) =>
  record.kind === "thread" || record.kind === "environment";

/** Uploads the edit's new attachments and saves it. Returns the error to show, or null. */
export async function submitQueuedRunEdit(input: {
  readonly environmentId: EnvironmentId;
  readonly draftTarget: ComposerThreadTarget;
  readonly editing: EditingQueuedRun;
  readonly content: QueuedRunEditContent;
  readonly modelSelection?: ModelSelection;
  readonly editQueuedRun: ReturnType<typeof useEditQueuedRunCommand>;
  readonly draftChanged: () => boolean;
}): Promise<string | null> {
  const { environmentId, draftTarget, editing, content } = input;
  const editText = content.prompt.trim();
  const newAttachments = [...content.images, ...content.files];
  const uploadFiles = async (files: ReadonlyArray<ComposerFileAttachment>) => {
    const validateFiles = () => {
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
      const reason = fileAttachmentCapabilityBlockReason({
        files,
        attachmentUploadsCapabilityKnown: config !== null,
        supportsAttachmentUploads: config !== null,
        maxFileAttachmentBytes:
          config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
      });
      if (reason !== null) throw new Error(reason);
    };
    validateFiles();
    for (const file of files) startAttachmentUpload({ environmentId, image: file, draftTarget });
    await awaitAttachmentUploads(files.map((file) => file.id));
    await refreshExpiredAttachmentUploads({ environmentId, images: files, draftTarget });
    validateFiles();
    const uploaded = getUploadedAttachments({ environmentId, images: files });
    if (uploaded === null) throw new Error(m(msg("Retry or remove failed uploads before saving.")));
    return uploaded;
  };
  try {
    const uploads = await prepareQueuedEditAttachments({
      existingAttachments: editing.existingAttachments,
      images: content.images,
      files: content.files,
      readImage: readFileAsDataUrl,
      uploadFiles,
    });
    if (input.draftChanged())
      return m(msg("Draft changed while preparing this message. Review it and save again."));
    // The edit draft owns thread and machine mentions, so a chip removed while editing is dropped.
    const keptRecords = (editing.context?.records ?? []).filter(
      (record) =>
        !isDraftOwnedRecord(record) &&
        (!("attachmentId" in record) ||
          editing.existingAttachments.some((attachment) => attachment.id === record.attachmentId)),
    );
    const newRecords =
      buildMessageContext({
        terminalContexts: content.terminalContexts.filter(
          (context) => context.text.trim().length > 0,
        ),
        reviewComments: content.reviewComments,
        previewAnnotations: content.previewAnnotations,
        threadContexts: content.threadContexts,
        knowledgeContexts: content.knowledgeContexts ?? [],
        environmentContexts: content.environmentContexts,
        replyTo: content.replyTo ?? null,
        attachments: newAttachments.map((attachment, index) => ({
          attachment,
          attachmentId: uploads[editing.existingAttachments.length + index]?.id ?? attachment.id,
        })),
      })?.records ?? [];
    const result = await input.editQueuedRun({
      environmentId,
      input: {
        threadId: editing.threadId,
        runId: editing.runId,
        text: restoreAttachmentOnlyBootstrapPrompt(editText, uploads.length > 0),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        edit: {
          messageId: editing.messageId,
          attachments: uploads,
          context: {
            version: 1,
            records: [
              ...new Map(
                [...keptRecords, ...newRecords].map(
                  (record) => [record.contextId, record] as const,
                ),
              ).values(),
            ],
          },
        },
      },
    });
    return result._tag === "Failure" ? m(msg("Could not save the edited queued message.")) : null;
  } catch (error) {
    return thrownErrorMessage(error, m) ?? m(msg("Could not save the edited queued message."));
  }
}

function useEditQueuedRunCommand() {
  return useAtomCommand(threadEnvironment.editQueuedRun, { reportFailure: false });
}

/** Edits preserve the thread draft; attachment removals stay local until save. */
export function useQueuedRunEdit(input: {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly threadDraftTarget: ComposerThreadTarget;
  readonly activeThreadId: ThreadId | null;
  readonly serverProjection: ThreadStructure | null;
  readonly promptRef: { current: string };
  readonly composerRef: RefObject<ChatComposerHandle | null>;
}) {
  const {
    environmentId,
    routeThreadRef,
    currentRouteThreadKeyRef,
    threadDraftTarget,
    activeThreadId,
    serverProjection,
    promptRef,
    composerRef,
  } = input;
  const editQueuedRunCommand = useEditQueuedRunCommand();
  const promoteQueuedRun = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const editKey = scopedThreadKey(routeThreadRef);
  const storedEdit = useAtomValue(queuedRunEdits.atom)[editKey] ?? null;
  const editing = activeThreadId === null ? null : storedEdit;
  const isSaving = useAtomValue(queuedRunEdits.savingAtom)[editKey] === true;
  const draftTarget =
    editing === null ? threadDraftTarget : queuedRunEditDraftId(routeThreadRef, editing.runId);

  const imageResources = (editing?.existingAttachments ?? [])
    .filter((attachment) => attachment.type === "image")
    .map((attachment) => ({ _tag: "attachment" as const, attachmentId: attachment.id }));
  const imageUrls = useAssetUrls(environmentId, imageResources);
  const urlByAttachmentId = new Map(
    imageResources.map((resource, index) => [resource.attachmentId, imageUrls[index] ?? null]),
  );
  const originalReferencedContextIds =
    editing === null ? null : new Set(collectInlineContextIds(editing.originalText));
  const attachmentContextIds = (attachment: ChatAttachment) =>
    editing === null
      ? []
      : attachmentContextIdsForRecord(editing.context, attachment).filter((contextId) =>
          originalReferencedContextIds!.has(contextId),
        );
  const editingAttachments =
    editing === null
      ? null
      : editing.existingAttachments.map((attachment) => ({
          attachment,
          url: urlByAttachmentId.get(attachment.id) ?? null,
          contextIds: attachmentContextIds(attachment),
        }));
  const existingAttachmentIds = new Set(
    (editing?.existingAttachments ?? []).map((attachment) => attachment.id),
  );
  const removedEditingAttachments =
    editing === null
      ? []
      : editing.originalAttachments
          .filter((attachment) => !existingAttachmentIds.has(attachment.id))
          .map((attachment) => ({
            attachment,
            contextIds: attachmentContextIds(attachment),
          }));

  const focusComposerSoon = () => {
    window.requestAnimationFrame(() => {
      if (currentRouteThreadKeyRef.current === editKey) composerRef.current?.focusAtEnd();
    });
  };
  const clearEditDraft = (runId: RunId) => {
    const target = queuedRunEditDraftId(routeThreadRef, runId);
    // A save in flight still sends these uploads.
    if (isSaving) {
      const store = useComposerDraftStore.getState();
      store.clearComposerContent(target);
      store.clearDraftThread(target);
    } else discardQueuedEditDraft(target);
  };

  const beginEdit = useStableCallback((request: EditQueuedRunRequest) => {
    if (activeThreadId === null) return;
    if (editing !== null && editing.runId !== request.runId) clearEditDraft(editing.runId);
    const target = queuedRunEditDraftId(routeThreadRef, request.runId);
    const sentText = stripAttachmentOnlyBootstrapPrompt(request.text);
    const message = serverProjection?.messages.find((message) => message.id === request.messageId);
    const context = message?.context;
    const referenced = new Set(collectInlineContextIds(sentText));
    const records = (context?.records ?? []).filter((record) => referenced.has(record.contextId));
    // A reply shows above the composer while its message is edited, not as a chip in the text.
    // Only the reply the text still points at: a removed or replaced one stays behind as a record.
    const reply = records.find(isResponseContextRecord);
    const text = reply ? removeInlineContextReference(sentText, reply.contextId).prompt : sentText;
    const store = useComposerDraftStore.getState();
    store.clearComposerContent(target);
    store.clearDraftThread(target);
    store.setPrompt(target, text);
    const run = serverProjection?.runs.find((run) => run.id === request.runId);
    const followsThreadSelection = message?.followsThreadSelection === true;
    const originalModelSelection = followsThreadSelection
      ? serverProjection?.thread.modelSelection
      : run?.modelSelection;
    if (run && !followsThreadSelection)
      store.setModelSelection(target, run.modelSelection, { explicit: true, replaceOptions: true });
    store.setThreadContexts(
      target,
      records.filter((record): record is ThreadContextRecord => record.kind === "thread"),
    );
    store.setEnvironmentContexts(
      target,
      records.filter((record): record is EnvironmentContextRecord => record.kind === "environment"),
    );
    if (reply) store.setReplyTo(target, reply);
    const threadRef = { environmentId, threadId: activeThreadId };
    queuedRunEdits.begin(
      editKey,
      {
        threadId: activeThreadId,
        runId: request.runId,
        messageId: request.messageId,
        originalText: text,
        followsThreadSelection,
        ...(originalModelSelection ? { originalModelSelection } : {}),
        originalAttachments: request.attachments,
        existingAttachments: request.attachments,
        context,
      },
      {
        runs: makeQueuedRunsAtom({
          threadId: activeThreadId,
          snapshot: threadEnvironment.snapshotAtom(environmentId),
          detailStatus: environmentThreadDetails.statusAtom(threadRef),
          runs: Atom.make(
            (get) =>
              get(environmentThreadDetails.quietThreadAtom(threadRef))?.projection.runs ?? null,
          ),
        }),
        // The run started or was cancelled from another client. A changed
        // edit moves into the thread's own draft when that draft is empty;
        // otherwise it is dropped. Edits outlive navigation, so the toast is
        // unscoped and names the thread: the user may be anywhere by now.
        onRunLeftQueue: (_, edit) => {
          const recovery = recoverQueuedMessageEdit({
            editTarget: queuedRunEditDraftId(routeThreadRef, edit.runId),
            threadTarget: threadDraftTarget,
            originalText: edit.originalText,
            ...(edit.originalModelSelection
              ? { originalModelSelection: edit.originalModelSelection }
              : {}),
            originalReplyTo: reply ?? null,
            removedExistingAttachment:
              edit.existingAttachments.length < edit.originalAttachments.length,
            existingAttachmentContextIds: (edit.context?.records ?? []).flatMap((record) =>
              (record.kind === "image" || record.kind === "file") && "attachmentId" in record
                ? [record.contextId]
                : [],
            ),
          });
          if (recovery === "clean") return;
          const title = appAtomRegistry.get(
            environmentThreadShells.threadShellAtom(threadRef),
          )?.title;
          toastManager.add(
            stackedThreadToast({
              type: recovery === "kept" ? "info" : "warning",
              title: m(msg("Queued message is no longer queued")),
              description:
                title === undefined
                  ? recovery === "kept"
                    ? m(msg("Your unsaved edit was kept in the composer."))
                    : m(msg("Your unsaved edit was discarded."))
                  : recovery === "kept"
                    ? m(msg("Your unsaved edit in “{title}” was kept in the composer.", { title }))
                    : m(msg("Your unsaved edit in “{title}” was discarded.", { title })),
            }),
          );
        },
      },
    );
    focusComposerSoon();
  });
  const cancelEdit = useStableCallback(() => {
    if (editing === null) return;
    clearEditDraft(editing.runId);
    queuedRunEdits.end(editKey);
    focusComposerSoon();
  });
  const removeEditingAttachment = useStableCallback((attachmentId: string) => {
    const removed = editing?.existingAttachments.find(
      (attachment) => attachment.id === attachmentId,
    );
    const contextIds = removed ? attachmentContextIdsForRecord(editing?.context, removed) : [];
    queuedRunEdits.update(editKey, (current) => ({
      ...current,
      existingAttachments: current.existingAttachments.filter(
        (attachment) => attachment.id !== attachmentId,
      ),
    }));
    if (editing !== null && contextIds.length > 0) {
      const target = queuedRunEditDraftId(routeThreadRef, editing.runId);
      const store = useComposerDraftStore.getState();
      const currentPrompt = store.getComposerDraft(target)?.prompt ?? "";
      const nextPrompt = contextIds.reduce(
        (prompt, contextId) => removeInlineContextReference(prompt, contextId).prompt,
        currentPrompt,
      );
      if (nextPrompt !== currentPrompt) store.setPrompt(target, nextPrompt);
    }
  });
  const restoreEditingAttachment = useStableCallback((attachment: ChatAttachment) => {
    queuedRunEdits.update(editKey, (current) => {
      const keptIds = new Set([
        ...current.existingAttachments.map((entry) => entry.id),
        attachment.id,
      ]);
      // Filtering the originals keeps the restored attachment in its original position.
      return {
        ...current,
        existingAttachments: current.originalAttachments.filter((entry) => keptIds.has(entry.id)),
      };
    });
  });

  // The same move as the queued row's "Send now" while a turn runs.
  const steerSavedRun = async (edited: EditingQueuedRun) => {
    const projection = appAtomRegistry.get(
      environmentThreadDetails.quietThreadAtom({ environmentId, threadId: edited.threadId }),
    )?.projection;
    if (!projection) return;
    const workflow = deriveThreadQueueWorkflowState(projection);
    const queued = workflow.queuedRuns.find(({ run }) => run.id === edited.runId);
    if (
      queued === undefined ||
      workflow.activeRun === null ||
      !workflow.canPromoteToSteer ||
      (queued.run.freshContext === true && !workflow.promoteSkipsCompaction)
    ) {
      return;
    }
    await promoteQueuedRun({
      environmentId,
      input: {
        threadId: edited.threadId,
        queuedRunId: edited.runId,
        targetRunId: workflow.activeRun.id,
      },
    });
  };

  const saveEdit = async (
    content: QueuedRunEditContent,
    setThreadError: (threadId: ThreadId, error: string | null) => void,
    submission?: {
      readonly dispatchMode: ComposerDispatchMode;
      readonly submissionIntent: ComposerSubmissionIntent;
    },
  ) => {
    if (editing === null || isSaving) return;
    const newAttachments = [...content.images, ...content.files];
    if (
      editing.existingAttachments.length + newAttachments.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      setThreadError(
        editing.threadId,
        m(
          msg("A message can have at most {max} attachments.", {
            max: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
          }),
        ),
      );
      return;
    }
    if (
      content.prompt.trim().length === 0 &&
      editing.existingAttachments.length === 0 &&
      newAttachments.length === 0
    ) {
      return;
    }
    // The save's result decides the edit's fate, even if the run starts meanwhile.
    const finishSave = queuedRunEdits.startSave(editKey);
    if (finishSave === null) return;
    const draftBeforeSave = useComposerDraftStore.getState().getComposerDraft(draftTarget);
    const draftChanged = () =>
      appAtomRegistry.get(queuedRunEdits.atom)[editKey] !== editing ||
      draftBeforeSave?.modelSelectionByProvider !==
        useComposerDraftStore.getState().getComposerDraft(draftTarget)?.modelSelectionByProvider ||
      composerDraftContentChanged(
        draftBeforeSave,
        useComposerDraftStore.getState().getComposerDraft(draftTarget),
      );
    const error = await submitQueuedRunEdit({
      environmentId,
      draftTarget,
      editing,
      content,
      ...(!editing.followsThreadSelection || draftBeforeSave?.modelSelectionExplicit
        ? { modelSelection: content.modelSelection }
        : {}),
      editQueuedRun: editQueuedRunCommand,
      draftChanged,
    });
    const changedAfterSave = error === null && draftChanged();
    setThreadError(
      editing.threadId,
      changedAfterSave
        ? m(msg("The earlier edit was saved. Review your newer changes and save again."))
        : error,
    );
    const current = finishSave(error === null && !changedAfterSave);
    if (!current) {
      // A failed save can recover into the thread draft; a newer edit can also retain resources.
      const drafts = Object.values(useComposerDraftStore.getState().draftsByThreadKey);
      const retainedIds = new Set(
        drafts.flatMap((draft) =>
          [...draft.images, ...draft.files].map((attachment) => attachment.id),
        ),
      );
      releaseDraftAttachments(
        newAttachments.filter((attachment) => !retainedIds.has(attachment.id)),
      );
      const retainedPreviews = new Set(
        drafts.flatMap((draft) => draft.images.map((image) => image.previewUrl)),
      );
      for (const image of content.images) {
        if (image.previewUrl.startsWith("blob:") && !retainedPreviews.has(image.previewUrl)) {
          URL.revokeObjectURL(image.previewUrl);
        }
      }
      return;
    }
    if (error !== null) return;
    if (changedAfterSave) return;
    releaseDraftAttachments(newAttachments);
    clearEditDraft(editing.runId);
    if (currentRouteThreadKeyRef.current === editKey) {
      promptRef.current = "";
      composerRef.current?.resetCursorState();
      focusComposerSoon();
    }
    // A plain submit means "Update queued message"; only the opposite-action shortcut or
    // modifier-click asks to steer, as it does for a new follow-up.
    if (submission?.submissionIntent === "alternate" && submission.dispatchMode === "steer") {
      await steerSavedRun(editing);
    }
  };

  return {
    editingRunId: editing?.runId ?? null,
    isEditing: editing !== null,
    isSaving,
    draftTarget,
    editingAttachments,
    removedEditingAttachments,
    beginEdit,
    cancelEdit,
    removeEditingAttachment,
    restoreEditingAttachment,
    saveEdit,
  };
}
