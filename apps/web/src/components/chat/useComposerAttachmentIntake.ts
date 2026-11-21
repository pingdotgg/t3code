import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import type { ChatComposerProps } from "./ChatComposer";
import {
  type ChatFileAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@t3tools/contracts";
import {
  type ComposerContextReference,
  collectInlineContextIds,
  stripInlineContextReferences,
} from "~/lib/composerContextReferences";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
  composerTargetKey,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";
import type { PendingUserInputProgress } from "../../pendingUserInput";
import type { ComposerAttachmentInsertion } from "../composerAttachmentInsertion";
import { type PendingUserInput } from "../../session-logic";
import { changeQuestionAttachmentPreparation } from "../../questionAttachments";
import {
  classifyComposerAttachmentFile,
  composerFileAttachmentMimeType,
  composerImageSourceKey,
  readComposerImageBytes,
  normalizeComposerImageFileMimeType,
  rememberComposerImageSource,
} from "./composerAttachmentFiles";
import {
  fileAttachmentTooLargeMessage,
  formatAttachmentSize,
} from "@t3tools/client-runtime/state/attachments";
import { fileContextReference, imageContextReference } from "~/lib/composerContextRecords";
import { isMacPlatform, randomUUID } from "~/lib/utils";
import {
  nextPastedTextFileName,
  pastedTextDisposition,
  wouldTextPasteExceedLimit,
} from "@t3tools/client-runtime/text-paste";
import {
  inheritComposerImageThumbnail,
  prepareImageForAttachment,
} from "../../lib/imageCompression";
import { requestConfirmDialog } from "~/confirmDialog";
import { toastManager } from "../ui/toast";
import { type RefObject, useRef } from "react";
import { serializeComposerImages } from "./composerImagePersistence";
import {
  addPreparingComposerImages,
  getPreparingComposerImages,
  isPreparingComposerImage,
  movedPreparingImageThread,
  removePreparingComposerImages,
} from "./preparingComposerImages";

/**
 * Takes files into the draft: validates and reserves slots, compresses images, inserts
 * their inline chips, folds large pastes into text attachments, and confirms removing a referenced image.
 */
export function useComposerAttachmentIntake(input: {
  readonly activeThreadId: ChatComposerProps["activeThreadId"];
  readonly activePendingProgress: PendingUserInputProgress | null;
  readonly activePendingIsResponding: boolean;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly supportsQuestionAttachments: boolean;
  readonly isLiteralPendingAnswer: boolean;
  readonly projectSelectionRequired: boolean;
  readonly questionAttachmentTarget: DraftId | null;
  readonly attachmentTargetKey: string;
  readonly fileStagingLimit: number | null;
  readonly promptRef: ChatComposerProps["promptRef"];
  readonly composerImagesRef: ChatComposerProps["composerImagesRef"];
  readonly composerFilesRef: ChatComposerProps["composerFilesRef"];
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly isRevertingCheckpointRef: RefObject<boolean>;
  readonly setThreadError: ChatComposerProps["setThreadError"];
  readonly countReservedAttachments: () => number;
  readonly addComposerImage: (image: ComposerImageAttachment) => string[];
  readonly addComposerImagesToDraft: (images: ComposerImageAttachment[]) => string[];
  readonly addComposerFilesToDraft: (files: ComposerFileAttachment[]) => string[];
  readonly removeComposerImageFromDraft: (imageId: string) => void;
  readonly insertAttachmentReferences: (
    references: ReadonlyArray<ComposerContextReference>,
    selection?: { start: number; end: number },
    pendingInsertion?: ComposerAttachmentInsertion,
  ) => boolean;
}) {
  const {
    activeThreadId,
    activePendingProgress,
    activePendingIsResponding,
    pendingUserInputs,
    supportsQuestionAttachments,
    isLiteralPendingAnswer,
    projectSelectionRequired,
    questionAttachmentTarget,
    attachmentTargetKey,
    fileStagingLimit,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerEditorRef,
    isRevertingCheckpointRef,
    setThreadError,
    countReservedAttachments,
    addComposerImage,
    addComposerImagesToDraft,
    addComposerFilesToDraft,
    removeComposerImageFromDraft,
    insertAttachmentReferences,
  } = input;
  const pastedTextFileNamesRef = useRef<{ targetKey: string; names: Set<string> }>({
    targetKey: "",
    names: new Set(),
  });

  const addComposerAttachments = async (
    files: File[],
    options?: {
      readonly source?: ChatFileAttachment["source"];
      readonly selection?: { start: number; end: number };
      readonly skipImageInlineChip?: boolean;
    },
  ): Promise<boolean> => {
    if (!activeThreadId || files.length === 0 || isRevertingCheckpointRef.current) return false;
    if (
      pendingUserInputs.length > 0 &&
      (!supportsQuestionAttachments ||
        activePendingProgress?.activeQuestion?.allowCustomAnswer === false ||
        activePendingIsResponding)
    ) {
      toastManager.add({
        type: "error",
        title: m(msg("This question cannot accept attachments.")),
      });
      return false;
    }
    // Captured before the awaits below: the user may switch threads while a
    // large image is being compressed, and the attachments and errors belong
    // to the thread the paste happened in.
    const threadId = activeThreadId;
    const imageAttachmentsGetChips =
      !options?.skipImageInlineChip &&
      (options?.selection !== undefined ||
        pendingUserInputs.length > 0 ||
        projectSelectionRequired ||
        stripInlineContextReferences(promptRef.current).trim().length > 0);

    // Validation happens synchronously so concurrent pastes see each other:
    // accepted files reserve their attachment slots (as preparing images)
    // before the first await, keeping the total under the limit.
    let reservedCount = countReservedAttachments();
    // A pick that matches a needs-reattach marker replaces it in the draft, so
    // it must not consume a slot; a draft full of markers would otherwise hit
    // the capacity error before the replacement path could run.
    const reattachMarkers = composerFilesRef.current.filter(composerFileNeedsReattach);
    const replacedReattachMarkerIds = new Set<string>();
    const acceptedImages: File[] = [];
    const acceptedFiles: ComposerFileAttachment[] = [];
    let error: string | null = null;
    for (const file of files) {
      const attachmentKind = classifyComposerAttachmentFile(file);
      const fileMimeType =
        attachmentKind === "file" ? composerFileAttachmentMimeType(file) : file.type;
      const matchingReattachMarker =
        attachmentKind === "file"
          ? reattachMarkers.find(
              (marker) =>
                !replacedReattachMarkerIds.has(marker.id) &&
                composerFileMatchesReattachMarker(marker, {
                  name: file.name || "file",
                  mimeType: fileMimeType,
                  sizeBytes: file.size,
                }),
            )
          : undefined;
      if (matchingReattachMarker) {
        replacedReattachMarkerIds.add(matchingReattachMarker.id);
      }
      if (!matchingReattachMarker && reservedCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = m(
          msg("You can attach up to {max} files per message.", {
            max: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
          }),
        );
        continue;
      }
      if (attachmentKind === "unsupported-image") {
        error = m(
          msg(
            "''{name}'' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.",
            { name: file.name },
          ),
        );
        continue;
      }
      if (attachmentKind === "image") {
        acceptedImages.push(normalizeComposerImageFileMimeType(file));
      } else {
        if (fileStagingLimit === null) {
          error = m(msg("This server does not support file attachments."));
          continue;
        }
        if (file.size <= 0) {
          error = m(msg("''{name}'' is empty or could not be read.", { name: file.name }));
          continue;
        }
        if (file.size > fileStagingLimit) {
          error = fileAttachmentTooLargeMessage(file.name, fileStagingLimit, m);
          continue;
        }
        const attachmentFile =
          file.type === fileMimeType
            ? file
            : new File([file], file.name, { type: fileMimeType, lastModified: file.lastModified });
        acceptedFiles.push({
          type: "file",
          id: randomUUID(),
          name: attachmentFile.name || "file",
          mimeType: fileMimeType,
          sizeBytes: attachmentFile.size,
          file: attachmentFile,
          ...(options?.source ? { source: options.source } : {}),
        });
      }
      if (!matchingReattachMarker) {
        reservedCount += 1;
      }
    }
    setThreadError(threadId, error);
    let insertedAny = false;
    if (acceptedFiles.length > 0) {
      const storedIds = new Set(addComposerFilesToDraft(acceptedFiles));
      const storedFiles = acceptedFiles.filter((file) => storedIds.has(file.id));
      if (storedFiles.length > 0) {
        insertedAny = insertAttachmentReferences(
          storedFiles.map(fileContextReference),
          options?.selection,
        );
      }
      if (options?.source?._tag === "pasted-text" && storedFiles.length > 0) {
        const attached = storedFiles[0]!;
        toastManager.add({
          type: "info",
          title: m(msg("Large paste attached as {name}", { name: attached.name })),
          description: m(
            msg("{size} · Use {shortcut} to keep a large paste inline.", {
              size: formatAttachmentSize(attached.sizeBytes, m),
              shortcut: isMacPlatform(navigator.platform) ? "⌘⇧V" : "Ctrl+Shift+V",
            }),
          ),
          data: { hideCopyButton: true },
        });
      }
    }
    if (acceptedImages.length === 0) return insertedAny;

    // The store drops a repeated image only after compressing it, so a likely repeat prepares
    // without a tile instead of flashing one. Only the store decides it is a duplicate.
    const imageSourceKeys = new Set(
      [...composerImagesRef.current, ...getPreparingComposerImages(attachmentTargetKey)].map(
        (image) => composerImageSourceKey(image.file),
      ),
    );
    // The draft image reuses its placeholder's id and thumbnail so the strip tile stays exactly
    // as it is when the compressed file replaces it.
    const preparingImages = acceptedImages.map((file) => {
      const sourceKey = composerImageSourceKey(file);
      const hidden = imageSourceKeys.has(sourceKey);
      imageSourceKeys.add(sourceKey);
      return { id: randomUUID(), name: file.name || "image", file, hidden };
    });
    addPreparingComposerImages(attachmentTargetKey, preparingImages);
    if (questionAttachmentTarget)
      changeQuestionAttachmentPreparation(questionAttachmentTarget, acceptedImages.length);
    const compressed: { id: string; file: File }[] = [];
    // Keyed by image so a failure whose tile was removed (even mid-compression) is not reported.
    const compressionErrors = new Map<string, string>();
    const pendingInsertion = imageAttachmentsGetChips
      ? composerEditorRef.current?.captureAttachmentInsertion()
      : undefined;
    for (const image of preparingImages) {
      const { id, file } = image;
      const movedThread = movedPreparingImageThread(image);
      // Removed from the strip while an earlier image was compressing.
      if (
        !isPreparingComposerImage(
          movedThread ? composerTargetKey(movedThread) : attachmentTargetKey,
          id,
        )
      )
        continue;
      // A rejection must still reach the cleanup below: a leaked
      // placeholder would block sending from this draft for good.
      const result = await prepareImageForAttachment(
        file,
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      ).catch(() => ({ ok: false, reason: "unreadable" }) as const);
      if (!result.ok) {
        compressionErrors.set(
          id,
          result.reason === "unreadable"
            ? m(msg("''{name}'' could not be read as an image.", { name: file.name }))
            : m(
                msg("''{name}'' is too large to attach, even after compression.", {
                  name: file.name,
                }),
              ),
        );
        continue;
      }
      await inheritComposerImageThumbnail(file, result.file);
      await readComposerImageBytes(result.file);
      rememberComposerImageSource(file, result.file);
      compressed.push({ id, file: result.file });
    }
    pendingInsertion?.dispose();
    const movedThread = preparingImages.map(movedPreparingImageThread).find(Boolean);
    const completionTargetKey = movedThread ? composerTargetKey(movedThread) : attachmentTargetKey;
    const nextImages: ComposerImageAttachment[] = compressed
      .filter(({ id }) => isPreparingComposerImage(completionTargetKey, id))
      .map(({ id, file }) => ({
        type: "image",
        id,
        name: file.name || "image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: URL.createObjectURL(file),
        file,
      }));
    const unrestoredImageNames: string[] = [];
    const draftStore = useComposerDraftStore.getState();
    const storedImageIds = new Set(
      movedThread
        ? draftStore.addImages(movedThread, nextImages, {
            onCapacityExceeded: (image) => unrestoredImageNames.push(image.name),
          })
        : nextImages.length === 1 && nextImages[0]
          ? addComposerImage(nextImages[0])
          : nextImages.length > 1
            ? addComposerImagesToDraft(nextImages)
            : [],
    );
    // Keep the placeholders until the draft decides whether the recovered images fit,
    // so a held send can be cancelled before the last placeholder disappears.
    const stillPreparingIds = removePreparingComposerImages(
      completionTargetKey,
      new Set(preparingImages.map((image) => image.id)),
      { cancelSubmission: compressionErrors.size > 0 || unrestoredImageNames.length > 0 },
    );
    if (questionAttachmentTarget && !movedThread)
      changeQuestionAttachmentPreparation(questionAttachmentTarget, -stillPreparingIds.size);
    const storedImages = nextImages.filter((image) => storedImageIds.has(image.id));
    // The draft may be gone by now; revoking a URL the store already revoked is harmless.
    for (const image of nextImages) {
      if (!storedImageIds.has(image.id)) URL.revokeObjectURL(image.previewUrl);
    }
    if (storedImages.length > 0 && imageAttachmentsGetChips && !movedThread) {
      insertedAny =
        insertAttachmentReferences(
          storedImages.map(imageContextReference),
          undefined,
          pendingInsertion,
        ) || insertedAny;
    }
    // Only failures are reported here. Success must not pass `null`: by
    // now other work (a failed send, an overlapping paste) may have set a
    // thread error this call knows nothing about, and clearing it would
    // swallow that message.
    const completionErrors = [...compressionErrors]
      .filter(([id]) => stillPreparingIds.has(id))
      .map(([, message]) => message)
      .slice(-1);
    if (unrestoredImageNames.length > 0) {
      completionErrors.push(
        m(
          msg("{names} could not be restored: the composer is at its {limit}-attachment limit.", {
            names: unrestoredImageNames.join(", "),
            limit: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
          }),
        ),
      );
    }
    if (completionErrors.length > 0) {
      setThreadError(threadId, completionErrors.join("\n"));
    }
    if (movedThread && storedImages.length > 0) {
      const serialized = await serializeComposerImages(storedImages, []);
      await draftStore.appendPersistedAttachments(movedThread, storedImages, serialized);
    }
    return insertedAny;
  };

  const removeComposerImage = (imageId: string) => {
    if (
      removePreparingComposerImages(attachmentTargetKey, new Set([imageId]), {
        cancelSubmission: true,
      }).size > 0
    ) {
      // Its compression finishes in the background and is dropped.
      if (questionAttachmentTarget)
        changeQuestionAttachmentPreparation(questionAttachmentTarget, -1);
      return;
    }
    const image = composerImagesRef.current.find((candidate) => candidate.id === imageId);
    const referenced = collectInlineContextIds(promptRef.current).includes(
      image ? imageContextReference(image).contextId : "",
    );
    if (!referenced) {
      removeComposerImageFromDraft(imageId);
      return;
    }
    const confirmation = requestConfirmDialog(
      image?.name != null
        ? m(
            msg(
              "Remove {name} from the message?\nIt is referenced in your text; removing it also removes every reference.",
              { name: image.name },
            ),
          )
        : m(
            msg(
              "Remove this image from the message?\nIt is referenced in your text; removing it also removes every reference.",
            ),
          ),
      { variant: "destructive" },
    );
    if (!confirmation) {
      removeComposerImageFromDraft(imageId);
      return;
    }
    void confirmation.then((confirmed) => {
      if (confirmed) removeComposerImageFromDraft(imageId);
    });
  };

  const foldPastedText = (
    plainText: string,
    bypassAutoAttachment: boolean,
    selectionOverride?: { start: number; end: number },
  ): boolean => {
    if (isLiteralPendingAnswer) return false;
    const questionCanAttach =
      pendingUserInputs.length === 0 ||
      (supportsQuestionAttachments &&
        activePendingProgress?.activeQuestion?.allowCustomAnswer !== false &&
        !activePendingIsResponding);
    const hasAttachmentSlot = countReservedAttachments() < PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
    const selection = selectionOverride ?? composerEditorRef.current?.readSelectionRange();
    const wouldExceedInputLimit = wouldTextPasteExceedLimit({
      valueLength: promptRef.current.length,
      selection: selection ?? { start: 0, end: 0 },
      textLength: plainText.length,
      maxLength: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    });
    const shouldFold =
      pastedTextDisposition({
        text: plainText,
        bypassAutoAttachment,
        wouldExceedInputLimit,
        canAttach: true,
        prompt: { value: promptRef.current, selection: selection ?? { start: 0, end: 0 } },
      }) === "attachment";
    if (!shouldFold) {
      return false;
    }

    const canStageAttachment =
      Boolean(activeThreadId) &&
      !isRevertingCheckpointRef.current &&
      questionCanAttach &&
      hasAttachmentSlot;
    if (!canStageAttachment || fileStagingLimit === null) {
      if (!wouldExceedInputLimit) {
        return false;
      }
      toastManager.add({
        type: "error",
        title: m(msg("Pasted text is too large for this message")),
        description: m(msg("Remove some text or an attachment, then paste again.")),
        data: { hideCopyButton: true },
      });
      return true;
    }

    if (pastedTextFileNamesRef.current.targetKey !== attachmentTargetKey) {
      pastedTextFileNamesRef.current = { targetKey: attachmentTargetKey, names: new Set() };
    }
    const reservedNames = pastedTextFileNamesRef.current.names;
    for (const file of composerFilesRef.current) reservedNames.add(file.name);
    const foldedFileName = nextPastedTextFileName([...reservedNames]);
    reservedNames.add(foldedFileName);
    const foldedFile = new File([plainText], foldedFileName, {
      type: "text/plain;charset=utf-8",
    });
    if (foldedFile.size > fileStagingLimit) {
      reservedNames.delete(foldedFileName);
      if (!wouldExceedInputLimit) return false;
      toastManager.add({
        type: "error",
        title: m(msg("Pasted text is too large to attach")),
        description: m(msg("Reduce the clipboard contents or save a smaller excerpt as a file.")),
        data: { hideCopyButton: true },
      });
      return true;
    }

    void addComposerAttachments([foldedFile], {
      source: { _tag: "pasted-text" },
      ...(selection ? { selection } : {}),
    });
    return true;
  };

  return {
    addComposerAttachments,
    removeComposerImage,
    foldPastedText,
  };
}
