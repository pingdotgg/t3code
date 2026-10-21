import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatAttachment,
  type EnvironmentId,
  type MessageId,
  type OrchestrationMessageContext,
  type OrchestrationV2ThreadProjection,
  type PreviewAnnotationPayload,
  type RunId,
  type ScopedThreadRef,
  type ThreadContextRecord,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { useEffect, useRef, useState, type RefObject } from "react";
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
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ChatComposerHandle } from "./ChatComposer";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { prepareQueuedEditAttachments, recoverQueuedMessageEdit } from "./queuedMessageEdit";
import type { EditQueuedRunRequest } from "./QueuedRunsControl";

interface EditingQueuedRun {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}

/** What the composer holds when the user saves a queued-message edit. */
export interface QueuedRunEditContent {
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}

/** Draft id for editing a queued run of the route thread. */
function queuedEditDraftTarget(routeThreadRef: ScopedThreadRef, runId: RunId) {
  return DraftId.make(`queued-edit:${scopedThreadKey(routeThreadRef)}:${runId}`);
}

/** Uploads the edit's new attachments and saves it. Returns the error to show, or null. */
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
    // Kept records for removed attachments would point at nothing.
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

/**
 * Queued-message edit mode. While active, the composer is retargeted to a
 * per-run edit draft so the user's in-progress draft on the thread survives
 * untouched; `existingAttachments` tracks which stored attachments the edit
 * keeps (removal is client state until save).
 */
export function useQueuedRunEdit(input: {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly threadDraftTarget: ComposerThreadTarget;
  // Null while the route has no thread yet; an edit needs one to target.
  readonly activeThreadId: ThreadId | null;
  readonly serverProjection: OrchestrationV2ThreadProjection | null;
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
  const setQueuedRunEditingCommand = useAtomCommand(threadEnvironment.setQueuedRunEditing, {
    reportFailure: false,
  });
  const [editing, setEditing] = useState<EditingQueuedRun | null>(null);
  const saveInFlightRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  // Navigating to another thread ends the edit; its draft stays for later.
  if (editing !== null && activeThreadId !== editing.threadId) {
    setEditing(null);
  }
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

  // The edited run is addressed explicitly rather than through the hook's
  // current props: by the time the cleanup below clears the flag, navigation
  // may already have pointed this view at another environment.
  const markQueuedRunEditing = useStableCallback(
    (
      target: Pick<EditingQueuedRun, "environmentId" | "threadId" | "runId">,
      isEditing: boolean,
    ) => {
      void setQueuedRunEditingCommand({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, runId: target.runId, editing: isEditing },
      });
    },
  );
  const beginEdit = useStableCallback((request: EditQueuedRunRequest) => {
    if (activeThreadId === null) return;
    if (editing !== null && editing.runId !== request.runId) clearEditDraft(editing.runId);
    markQueuedRunEditing({ environmentId, threadId: activeThreadId, runId: request.runId }, true);
    const target = queuedEditDraftTarget(routeThreadRef, request.runId);
    const store = useComposerDraftStore.getState();
    store.clearComposerContent(target);
    store.setPrompt(target, request.text);
    setEditing({
      environmentId,
      threadId: activeThreadId,
      runId: request.runId,
      messageId: request.messageId,
      originalText: request.text,
      existingAttachments: request.attachments,
      context: serverProjection?.messages.find((message) => message.id === request.messageId)
        ?.context,
    });
    focusComposerSoon();
  });
  const cancelEdit = useStableCallback(() => {
    if (editing === null) return;
    clearEditDraft(editing.runId);
    setEditing(null);
    focusComposerSoon();
  });
  const removeEditingAttachment = useStableCallback((attachmentId: string) => {
    setEditing((current) =>
      current === null
        ? current
        : {
            ...current,
            existingAttachments: current.existingAttachments.filter(
              (attachment) => attachment.id !== attachmentId,
            ),
          },
    );
  });

  const editingEnvironmentId = editing?.environmentId ?? null;
  const editingThreadId = editing?.threadId ?? null;
  const editingRunId = editing?.runId ?? null;
  // beginEdit marks the run before this effect runs, so switching to another
  // queued message never leaves a gap in which the queue could start it. The
  // cleanup is the single place an edit ends: save, cancel, leaving the thread
  // and unmount all pass through it.
  useEffect(() => {
    if (editingEnvironmentId === null || editingThreadId === null || editingRunId === null) return;
    return () =>
      markQueuedRunEditing(
        { environmentId: editingEnvironmentId, threadId: editingThreadId, runId: editingRunId },
        false,
      );
  }, [editingEnvironmentId, editingThreadId, editingRunId, markQueuedRunEditing]);

  // Exit edit mode when the edited run leaves the queue (it started, or was
  // cancelled from another client). A dirty edit moves into the thread's own
  // draft when that draft is empty; otherwise it is dropped with a toast.
  useEffect(() => {
    if (editing === null || activeThreadId !== editing.threadId) return;
    if (serverProjection === null) return;
    const run = serverProjection.runs.find((candidate) => candidate.id === editing.runId);
    if (run !== undefined && run.status === "queued") return;
    const recovery = recoverQueuedMessageEdit({
      editTarget: queuedEditDraftTarget(routeThreadRef, editing.runId),
      threadTarget: threadDraftTarget,
      originalText: editing.originalText,
    });
    if (recovery !== "clean") {
      toastManager.add(
        stackedThreadToast({
          type: recovery === "kept" ? "info" : "warning",
          title: "Queued message is no longer queued",
          description:
            recovery === "kept"
              ? "Your unsaved edit was kept in the composer."
              : "Your unsaved edit was discarded.",
        }),
      );
    }
    // oxlint-disable-next-line react/set-state-in-effect -- Leaving edit mode follows the draft recovery and toast above, which must run once after commit.
    setEditing(null);
  }, [activeThreadId, editing, routeThreadRef, serverProjection, threadDraftTarget]);

  /**
   * Saves the composer content into the queued message being edited. Reports
   * failures through `setThreadError`, which callers own because the error
   * banner lives with the thread.
   */
  const saveEdit = async (
    content: QueuedRunEditContent,
    setThreadError: (threadId: ThreadId, error: string | null) => void,
  ) => {
    if (editing === null || saveInFlightRef.current) return;
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
    saveInFlightRef.current = true;
    setIsSaving(true);
    const error = await submitQueuedRunEdit({
      environmentId,
      draftTarget,
      editing,
      content,
      editQueuedRun: editQueuedRunCommand,
    });
    saveInFlightRef.current = false;
    setIsSaving(false);
    setThreadError(editing.threadId, error);
    if (error !== null) return;
    releaseDraftAttachments(newAttachments);
    promptRef.current = "";
    clearEditDraft(editing.runId);
    composerRef.current?.resetCursorState();
    setEditing(null);
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
