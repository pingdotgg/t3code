import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type CommandId,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
  type ThreadContextRecord,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { queuedRunEditOwnership } from "@t3tools/client-runtime/state/threads";
import { readLocalApi } from "../../localApi";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { useShallow } from "zustand/react/shallow";
import { useEffect, useRef, useState, type RefObject } from "react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { assetEnvironment } from "../../state/assets";
import { readPreparedConnection } from "../../state/session";
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
import { readFileAsDataUrl } from "../../lib/imageCompression";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ChatComposerHandle } from "./ChatComposer";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import {
  prepareQueuedEditPayload,
  prepareQueuedMessageEditDraft,
  recoverQueuedMessageEdit,
} from "./queuedMessageEdit";
import type { EditQueuedRunRequest } from "./QueuedRunsControl";

import type { QueuedRunEditDraft } from "@t3tools/client-runtime/state/queued-run-edit-draft";

interface EditingQueuedRun extends QueuedRunEditDraft {
  readonly editId: CommandId | null;
  readonly sequence: number;
  readonly threadId: ThreadId;
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
    const payload = await prepareQueuedEditPayload({
      edit: editing,
      content,
      readImage: readFileAsDataUrl,
      uploadFiles,
    });
    const result = await input.editQueuedRun({
      environmentId,
      input: {
        threadId: editing.threadId,
        runId: editing.runId,
        editId: editing.editId,
        text: editText.length === 0 ? ATTACHMENT_ONLY_BOOTSTRAP_PROMPT : editText,
        edit: {
          messageId: editing.messageId,
          ...payload,
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
 * untouched. Stored attachments join that draft so its current selection can
 * be recovered through the same paths as newly attached files.
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
  const acquireEdit = useAtomCommand(threadEnvironment.beginQueuedRunEdit);
  const releaseEdit = useAtomCommand(threadEnvironment.cancelQueuedRunEdit);
  const releaseFailedPreparation = useAtomCommand(threadEnvironment.cancelQueuedRunEdit, {
    reportFailure: false,
  });
  const threadState = useEnvironmentThread(environmentId, activeThreadId);
  const beginInFlight = useRef(false);
  const recoveryPrefix = `queued-edit:${scopedThreadKey(routeThreadRef)}:`;
  const activeEdit = useComposerDraftStore(
    (state) =>
      Object.entries(state.draftsByThreadKey).find(
        ([key, draft]) =>
          key.startsWith(recoveryPrefix) && draft.queuedEdit?.ownership !== undefined,
      )?.[1].queuedEdit ?? null,
  );
  const editing: EditingQueuedRun | null =
    activeEdit?.ownership && activeThreadId !== null
      ? {
          ...activeEdit,
          ...activeEdit.ownership,
          threadId: activeThreadId,
        }
      : null;
  const saveInFlightRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const savedEditDrafts = useComposerDraftStore(
    useShallow((state) =>
      Object.keys(state.draftsByThreadKey).filter((key) => key.startsWith(recoveryPrefix)),
    ),
  );
  const [recoveryTarget, setRecoveryTarget] = useState<string | null>(null);
  const selectedRecoveryTarget =
    recoveryTarget !== null && savedEditDrafts.includes(recoveryTarget)
      ? DraftId.make(recoveryTarget)
      : null;
  const draftTarget =
    editing !== null
      ? queuedEditDraftTarget(routeThreadRef, editing.runId)
      : (selectedRecoveryTarget ?? threadDraftTarget);

  const focusComposerSoon = () => {
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  };
  const clearEditDraft = (runId: RunId) =>
    useComposerDraftStore
      .getState()
      .clearComposerContent(queuedEditDraftTarget(routeThreadRef, runId));

  const beginEdit = useStableCallback(async (request: EditQueuedRunRequest) => {
    if (activeThreadId === null || beginInFlight.current || saveInFlightRef.current) return;
    beginInFlight.current = true;
    try {
      const run = serverProjection?.runs.find((run) => run.id === request.runId);
      const previousEditId = run?.queueEditId ?? null;
      if (editing?.runId === request.runId && editing.editId === previousEditId) {
        focusComposerSoon();
        return;
      }
      if (previousEditId !== null) {
        const confirmed = await readLocalApi()?.dialogs.confirm(
          "This message is being edited elsewhere. Take over editing? The other editor will keep their unsaved changes.",
        );
        if (!confirmed) return;
      }
      if (editing !== null) {
        const released = await releaseEdit({
          environmentId,
          input: { threadId: editing.threadId, runId: editing.runId, editId: editing.editId },
        });
        if (released._tag !== "Success") return;
        recoverQueuedMessageEdit({
          editTarget: queuedEditDraftTarget(routeThreadRef, editing.runId),
          threadTarget: threadDraftTarget,
          originalText: editing.originalText,
          originalAttachmentIds: editing.originalAttachmentIds,
        });
      }
      const acquired = await acquireEdit({
        environmentId,
        input: { threadId: activeThreadId, runId: request.runId, previousEditId },
      });
      if (acquired._tag !== "Success") return;
      const target = queuedEditDraftTarget(routeThreadRef, request.runId);
      const preparation = prepareQueuedMessageEditDraft({
        editTarget: target,
        edit: {
          ...acquired.value,
          runId: request.runId,
          messageId: request.messageId,
          context: serverProjection?.messages.find((message) => message.id === request.messageId)
            ?.context,
        },
        environmentId,
        text: request.text,
        attachments: request.attachments,
        readImage: async (attachment) => {
          const connection = readPreparedConnection(environmentId);
          if (!connection) throw new Error("Reconnect before editing attachments.");
          const result = await executeAtomQuery(
            appAtomRegistry,
            assetEnvironment.createUrl({
              environmentId,
              input: { resource: { _tag: "attachment", attachmentId: attachment.id } },
            }),
            { refresh: true, reportFailure: false },
          );
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
          if (url === null) throw new Error("Attachment URL unavailable.");
          const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error(`Could not restore attachment: ${attachment.name}`);
          const file = new File([await response.blob()], attachment.name, {
            type: attachment.mimeType,
          });
          return { file, dataUrl: await readFileAsDataUrl(file) };
        },
      });
      const preparedEdit = useComposerDraftStore.getState().getComposerDraft(target)?.queuedEdit;
      try {
        await preparation;
      } catch (error) {
        const released = await releaseFailedPreparation({
          environmentId,
          input: { threadId: activeThreadId, runId: request.runId, editId: acquired.value.editId },
        });
        if (released._tag === "Success" && preparedEdit?.ownership)
          recoverQueuedMessageEdit({
            editTarget: target,
            threadTarget: threadDraftTarget,
            originalText: preparedEdit.originalText,
            originalAttachmentIds: preparedEdit.originalAttachmentIds,
            expectedEdit: preparedEdit,
          });
        toastManager.add({
          type: "error",
          title: "Could not open queued edit",
          description: error instanceof Error ? error.message : "Could not restore attachments.",
        });
        return;
      }
      focusComposerSoon();
    } finally {
      beginInFlight.current = false;
    }
  });
  const cancelEdit = useStableCallback(async () => {
    if (editing === null || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setIsSaving(true);
    const released = await releaseEdit({
      environmentId,
      input: { threadId: editing.threadId, runId: editing.runId, editId: editing.editId },
    });
    saveInFlightRef.current = false;
    setIsSaving(false);
    if (released._tag !== "Success") return;
    clearEditDraft(editing.runId);
    focusComposerSoon();
  });
  useEffect(() => {
    if (
      editing === null ||
      activeThreadId !== editing.threadId ||
      saveInFlightRef.current ||
      isSaving
    )
      return;
    if (queuedRunEditOwnership(threadState, editing) !== "lost") return;
    const recovery = recoverQueuedMessageEdit({
      editTarget: queuedEditDraftTarget(routeThreadRef, editing.runId),
      threadTarget: threadDraftTarget,
      originalText: editing.originalText,
      originalAttachmentIds: editing.originalAttachmentIds,
    });
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Queued message edit ended",
        description:
          recovery === "kept"
            ? "Your unsaved changes are in the composer."
            : recovery === "retained"
              ? "Open Saved queued edit above the composer to recover your changes."
              : "The message left the queue or another editor took over.",
      }),
    );
  }, [activeThreadId, editing, routeThreadRef, threadState, threadDraftTarget, isSaving]);

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
    if (newAttachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      setThreadError(
        editing.threadId,
        `A message can have at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
      return;
    }
    if (content.prompt.trim().length === 0 && newAttachments.length === 0) {
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
    focusComposerSoon();
  };

  return {
    savedEditDrafts: editing === null ? savedEditDrafts : [],
    recoveryTarget: selectedRecoveryTarget,
    selectRecoveryTarget: setRecoveryTarget,
    editingRunId: editing?.runId ?? null,
    isEditing: editing !== null,
    isSaving,
    draftTarget,
    beginEdit,
    cancelEdit,
    saveEdit,
  };
}
