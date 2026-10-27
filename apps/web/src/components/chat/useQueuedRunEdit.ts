import { useAtomValue } from "@effect/atom-react";
import {
  makeQueuedRunEditStore,
  makeQueuedRunsAtom,
} from "@t3tools/client-runtime/queued-run-edit";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatAttachment,
  type EnvironmentContextRecord,
  type EnvironmentId,
  type MessageId,
  type OrchestrationMessageContext,
  type PreviewAnnotationPayload,
  type RunId,
  type ScopedThreadRef,
  type ThreadContextRecord,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { Atom } from "effect/reactivity";
import type { RefObject } from "react";
import { useAssetUrls } from "../../assets/assetUrls";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import type { TerminalContextDraft } from "../../lib/terminalContext";
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
import { prepareQueuedEditAttachments, recoverQueuedMessageEdit } from "./queuedMessageEdit";
import type { EditQueuedRunRequest } from "./QueuedRunsControl";

interface EditingQueuedRun {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}

// Keyed by the route thread, so an edit survives navigating away and back.
const queuedRunEdits = makeQueuedRunEditStore<EditingQueuedRun>({
  registry: appAtomRegistry,
  label: "web-queued-run-edits",
});

export interface QueuedRunEditContent {
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly environmentContexts: ReadonlyArray<EnvironmentContextRecord>;
}

function queuedEditDraftTarget(routeThreadRef: ScopedThreadRef, runId: RunId) {
  return DraftId.make(`queued-edit:${scopedThreadKey(routeThreadRef)}:${runId}`);
}

async function submitQueuedRunEdit(input: {
  readonly environmentId: EnvironmentId;
  readonly draftTarget: ComposerThreadTarget;
  readonly editing: EditingQueuedRun;
  readonly content: QueuedRunEditContent;
  readonly editQueuedRun: ReturnType<typeof useEditQueuedRunCommand>;
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
        supportsAttachmentUploads: config?.environment.capabilities.attachmentUploads === true,
        maxFileAttachmentBytes:
          config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
      });
      if (reason !== null) throw new Error(reason);
    };
    validateFiles();
    for (const file of files) startAttachmentUpload({ environmentId, image: file, draftTarget });
    await awaitAttachmentUploads(files.map((file) => file.id));
    validateFiles();
    const uploaded = getUploadedAttachments({ environmentId, images: files });
    if (uploaded === null) throw new Error("Retry or remove failed uploads before saving.");
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
    const keptRecords = (editing.context?.records ?? []).filter(
      (record) =>
        !("attachmentId" in record) ||
        editing.existingAttachments.some((attachment) => attachment.id === record.attachmentId),
    );
    const newRecords =
      buildMessageContext({
        terminalContexts: content.terminalContexts.filter(
          (context) => context.text.trim().length > 0,
        ),
        reviewComments: content.reviewComments,
        previewAnnotations: content.previewAnnotations,
        threadContexts: content.threadContexts,
        environmentContexts: content.environmentContexts,
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
        text: editText.length === 0 ? ATTACHMENT_ONLY_BOOTSTRAP_PROMPT : editText,
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
    return result._tag === "Failure" ? "Could not save the edited queued message." : null;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not save the edited queued message.";
  }
}

function useEditQueuedRunCommand() {
  return useAtomCommand(threadEnvironment.editQueuedRun, { reportFailure: false });
}

/** Edits preserve the thread draft; attachment removals stay local until save. */
export function useQueuedRunEdit(input: {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly threadDraftTarget: ComposerThreadTarget;
  readonly activeThreadId: ThreadId | null;
  readonly serverProjection: ThreadStructure | null;
  readonly promptRef: { current: string };
  readonly composerRef: RefObject<ChatComposerHandle | null>;
}) {
  const {
    environmentId,
    routeThreadRef,
    threadDraftTarget,
    activeThreadId,
    serverProjection,
    promptRef,
    composerRef,
  } = input;
  const editQueuedRunCommand = useEditQueuedRunCommand();
  const editKey = scopedThreadKey(routeThreadRef);
  const storedEdit = useAtomValue(queuedRunEdits.atom)[editKey] ?? null;
  const editing = activeThreadId === null ? null : storedEdit;
  const isSaving = useAtomValue(queuedRunEdits.savingAtom)[editKey] === true;
  const draftTarget =
    editing === null ? threadDraftTarget : queuedEditDraftTarget(routeThreadRef, editing.runId);

  const imageResources = (editing?.existingAttachments ?? [])
    .filter((attachment) => attachment.type === "image")
    .map((attachment) => ({ _tag: "attachment" as const, attachmentId: attachment.id }));
  const imageUrls = useAssetUrls(environmentId, imageResources);
  const urlByAttachmentId = new Map(
    imageResources.map((resource, index) => [resource.attachmentId, imageUrls[index] ?? null]),
  );
  const editingAttachments =
    editing === null
      ? null
      : editing.existingAttachments.map((attachment) => ({
          attachment,
          url: urlByAttachmentId.get(attachment.id) ?? null,
        }));

  const focusComposerSoon = () => {
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  };
  const clearEditDraft = (runId: RunId) =>
    useComposerDraftStore
      .getState()
      .clearComposerContent(queuedEditDraftTarget(routeThreadRef, runId));

  const beginEdit = useStableCallback((request: EditQueuedRunRequest) => {
    if (activeThreadId === null) return;
    if (editing !== null && editing.runId !== request.runId) clearEditDraft(editing.runId);
    const target = queuedEditDraftTarget(routeThreadRef, request.runId);
    const store = useComposerDraftStore.getState();
    store.clearComposerContent(target);
    store.setPrompt(target, request.text);
    const threadRef = { environmentId, threadId: activeThreadId };
    queuedRunEdits.begin(
      editKey,
      {
        threadId: activeThreadId,
        runId: request.runId,
        messageId: request.messageId,
        originalText: request.text,
        existingAttachments: request.attachments,
        context: serverProjection?.messages.find((message) => message.id === request.messageId)
          ?.context,
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
            editTarget: queuedEditDraftTarget(routeThreadRef, edit.runId),
            threadTarget: threadDraftTarget,
            originalText: edit.originalText,
          });
          if (recovery === "clean") return;
          const title = appAtomRegistry.get(
            environmentThreadShells.threadShellAtom(threadRef),
          )?.title;
          const where = title === undefined ? "" : ` in “${title}”`;
          toastManager.add(
            stackedThreadToast({
              type: recovery === "kept" ? "info" : "warning",
              title: "Queued message is no longer queued",
              description:
                recovery === "kept"
                  ? `Your unsaved edit${where} was kept in the composer.`
                  : `Your unsaved edit${where} was discarded.`,
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
    queuedRunEdits.update(editKey, (current) => ({
      ...current,
      existingAttachments: current.existingAttachments.filter(
        (attachment) => attachment.id !== attachmentId,
      ),
    }));
  });

  const saveEdit = async (
    content: QueuedRunEditContent,
    setThreadError: (threadId: ThreadId, error: string | null) => void,
  ) => {
    if (editing === null || isSaving) return;
    const newAttachments = [...content.images, ...content.files];
    if (
      editing.existingAttachments.length + newAttachments.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      setThreadError(
        editing.threadId,
        `A message can have at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
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
    const error = await submitQueuedRunEdit({
      environmentId,
      draftTarget,
      editing,
      content,
      editQueuedRun: editQueuedRunCommand,
    });
    setThreadError(editing.threadId, error);
    const current = finishSave(error === null);
    if (error !== null) return;
    releaseDraftAttachments(newAttachments);
    // The edit was cancelled or begun again while this save ran; its drafts are the newer edit's.
    if (!current) return;
    promptRef.current = "";
    clearEditDraft(editing.runId);
    composerRef.current?.resetCursorState();
    focusComposerSoon();
  };

  return {
    editingRunId: editing?.runId ?? null,
    isEditing: editing !== null,
    isSaving,
    draftTarget,
    editingAttachments,
    beginEdit,
    cancelEdit,
    removeEditingAttachment,
    saveEdit,
  };
}
