import type { ChatComposerProps } from "./ChatComposer";
import {
  type ComposerContextRecord,
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type PreviewAnnotationPayload,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import {
  type ComposerFileAttachment,
  type ComposerThreadDraftState,
  type PersistedComposerFileAttachment,
  type PersistedComposerImageAttachment,
  composerFileDedupKey,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
  composerTargetKey,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";
import {
  MAX_STASH_ENTRIES,
  type PromptStashEntry,
  partitionStashAttachments,
  usePromptStashStore,
} from "../../promptStashStore";
import { type PendingUserInput } from "../../session-logic";
import { type ReviewCommentContext } from "../../reviewCommentContext";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import { compressImageForStash } from "../../lib/imageCompression";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { pendingDraftWork } from "./pendingDraftWork";
import {
  previewAnnotationContextRecord,
  reviewCommentContextRecord,
  terminalContextRecord,
} from "~/lib/composerContextRecords";
import { randomUUID } from "~/lib/utils";
import {
  readAttachmentUpload,
  releaseAttachmentUpload,
  releasePersistedAttachmentUpload,
  verifyStashedAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { remainingComposerAttachmentSlots } from "./composerThreadImport";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { resizeSnapShotSource } from "../../lib/snapShotSource";
import { registerCommands } from "../../shortcuts/dispatcher";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { toastManager } from "../ui/toast";
import type { useComposerTriggerState } from "./useComposerTriggerState";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  BackgroundThreadContext,
  EmbeddedChatContext,
  isFromEmbeddedChat,
} from "./backgroundThread";
import { isInSideChatPane } from "../../lib/sideChatPane";
import { useStableCallback } from "../../hooks/useStableCallback";

/**
 * The prompt stash: saving the draft aside, restoring or deleting an entry, the badge pulse,
 * and the stash shortcut. Its state lives here so the composer body only wires it up.
 */
export function useComposerStash(input: {
  readonly environmentId: EnvironmentId;
  readonly composerDraftTarget: ChatComposerProps["composerDraftTarget"];
  readonly promptRef: ChatComposerProps["promptRef"];
  readonly readAttachmentDraft: () => Pick<ComposerThreadDraftState, "images" | "files">;
  readonly readTerminalContexts: () => ComposerThreadDraftState["terminalContexts"];
  readonly routeThreadRef: ChatComposerProps["routeThreadRef"];
  readonly projectSelectionRequired: boolean;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly activePendingProgress: ChatComposerProps["activePendingProgress"];
  readonly prompt: string;
  readonly composerMenuOpen: boolean;
  readonly isComposerCollapsedMobile: boolean;
  readonly composerPreviewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly composerReviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly composerThreadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly attachmentTargetKey: string;
  readonly isComposerDraftTargetOpen: (targetKey: string) => boolean;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly isRevertingCheckpoint: () => boolean;
  readonly pendingThreadImportsRef: RefObject<Map<string, number>>;
  readonly setComposerCursor: Dispatch<SetStateAction<number>>;
  readonly setComposerTrigger: ReturnType<typeof useComposerTriggerState>["setTrigger"];
  readonly importContextRecords: (
    records: ReadonlyArray<ComposerContextRecord>,
    sourceEnvironmentId: EnvironmentId | null,
    threadDraftTarget?: ChatComposerProps["composerDraftTarget"],
  ) => ReadonlyMap<string, string>;
  readonly expandMobileComposer: () => void;
}) {
  const {
    environmentId,
    composerDraftTarget,
    promptRef,
    readAttachmentDraft,
    readTerminalContexts,
    routeThreadRef,
    projectSelectionRequired,
    pendingUserInputs,
    activePendingProgress,
    prompt,
    composerMenuOpen,
    isComposerCollapsedMobile,
    composerPreviewAnnotations,
    composerReviewComments,
    composerThreadContexts,
    attachmentTargetKey,
    isComposerDraftTargetOpen,
    composerEditorRef,
    isRevertingCheckpoint,
    pendingThreadImportsRef,
    setComposerCursor,
    setComposerTrigger,
    importContextRecords,
    expandMobileComposer,
  } = input;
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  );
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  );
  const clearComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.clearTerminalContexts,
  );
  const clearComposerDraftPromptAndImages = useComposerDraftStore(
    (store) => store.clearComposerPromptAndImages,
  );
  const setComposerDraftThreadContexts = useComposerDraftStore((store) => store.setThreadContexts);
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  // Each stash bumps the key; the badge replays its one-shot pulse animation per key.
  const [stashPulseKey, setStashPulseKey] = useState(0);
  const stashInFlightRef = useRef<Set<string>>(new Set());

  const stashQueue = usePromptStashStore((state) => state.entries);
  const stashEntryToQueue = usePromptStashStore((state) => state.stashEntry);
  const takeStashEntry = usePromptStashStore((state) => state.takeEntry);
  const finalizeStashEntryImages = usePromptStashStore((state) => state.finalizeEntryImages);

  const pulseStashBadge = () => {
    setStashPulseKey((key) => key + 1);
  };

  const restoreStashEntry = async (menuEntry: PromptStashEntry) => {
    const filesToVerify = menuEntry.files ?? [];
    if (filesToVerify.some((file) => file.environmentId !== environmentId)) {
      toastManager.add({
        type: "error",
        title: "Stashed files belong to another environment",
        description: "Restore this prompt in the environment that received its files.",
      });
      return;
    }
    setIsStashMenuOpen(false);

    // An expired upload restores as a needs-reattach row instead of a reference
    // the next send would fail to verify. Verify BEFORE taking: the take
    // removes the entry from durable storage, and a tab closed during this
    // await must still find it there after reload.
    const verifications = await Promise.all(
      filesToVerify.map((file) =>
        verifyStashedAttachmentUpload({ environmentId, attachmentId: file.attachmentId }),
      ),
    );
    const expiredAttachmentIds = new Set(
      filesToVerify
        .filter((_, index) => verifications[index]?.status === "missing")
        .map((file) => file.attachmentId),
    );

    // A thread switch during the verify await would mix the new thread's
    // prompt with this invocation's captured target. Nothing was taken yet,
    // so abort and leave the entry restorable where the user now is.
    if (
      isRevertingCheckpoint() ||
      !isComposerDraftTargetOpen(composerTargetKey(composerDraftTarget))
    ) {
      return;
    }

    const { entry, durable } = takeStashEntry(menuEntry.id);
    if (!entry) return;
    if (!durable) {
      toastManager.add({
        type: "warning",
        title: "Restored prompt may reappear in the stash",
        description:
          "Browser storage rejected the update, so this entry could still be there after a reload.",
        data: { hideCopyButton: true },
      });
    }

    const rewrittenContextIds = entry.records
      ? importContextRecords(entry.records, null, composerDraftTarget)
      : new Map<string, string>();
    const restoredPrompt = replaceComposerContextReferences(entry.prompt, (reference) => {
      const contextId = rewrittenContextIds.get(reference.contextId);
      return contextId
        ? formatInlineContextReference({
            ...reference,
            contextId,
            kind: reference.kind === "element" ? "preview-annotation" : reference.kind,
          })
        : reference.source;
    });
    const currentPrompt = promptRef.current;
    const nextPrompt =
      restoredPrompt.length === 0
        ? currentPrompt
        : currentPrompt.trim().length
          ? `${currentPrompt.replace(/\s+$/, "")}\n\n${restoredPrompt}`
          : restoredPrompt;
    let promptChanged = nextPrompt !== currentPrompt;
    if (promptChanged) {
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(null);
    }

    let unrestoredFileNames: string[] = [];
    const expiredFileNames: string[] = [];
    let restoredFileCount = 0;
    const stashedFiles = entry.files ?? [];
    if (stashedFiles.length > 0) {
      const composerFilesNow = readAttachmentDraft().files;
      const existingFileIds = new Set(composerFilesNow.map((file) => file.id));
      const retainedUploadIds = new Set(
        composerFilesNow.flatMap((file) =>
          file.uploadedAttachmentId ? [file.uploadedAttachmentId] : [],
        ),
      );
      const existingFileKeys = new Set(composerFilesNow.map(composerFileDedupKey));
      const reattachMarkers = composerFilesNow.filter(composerFileNeedsReattach);
      const restoredMarkerIds = new Set<string>();
      const duplicateFiles: PersistedComposerFileAttachment[] = [];
      const markerReplacements: ComposerFileAttachment[] = [];
      const appendedFiles: ComposerFileAttachment[] = [];
      for (const file of stashedFiles) {
        const expired = expiredAttachmentIds.has(file.attachmentId);
        const key = composerFileDedupKey(file);
        const restored: ComposerFileAttachment = {
          type: "file",
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          file: null,
          ...(file.source ? { source: file.source } : {}),
          ...(expired
            ? {}
            : { uploadedAttachmentId: file.attachmentId, uploadEnvironmentId: environmentId }),
        };
        if (existingFileIds.has(file.id)) {
          if (!expired && !retainedUploadIds.has(file.attachmentId)) {
            duplicateFiles.push(file);
          }
          continue;
        }
        const reattachMarker = reattachMarkers.find(
          (marker) =>
            !restoredMarkerIds.has(marker.id) && composerFileMatchesReattachMarker(marker, file),
        );
        if (reattachMarker) {
          restoredMarkerIds.add(reattachMarker.id);
          existingFileIds.add(file.id);
          existingFileKeys.add(key);
          if (expired) {
            expiredFileNames.push(file.name);
          } else {
            retainedUploadIds.add(file.attachmentId);
            markerReplacements.push(restored);
          }
          continue;
        }
        if (existingFileKeys.has(key)) {
          if (!expired && !retainedUploadIds.has(file.attachmentId)) {
            duplicateFiles.push(file);
          }
          continue;
        }
        existingFileIds.add(file.id);
        existingFileKeys.add(key);
        if (expired) {
          expiredFileNames.push(file.name);
        } else {
          retainedUploadIds.add(file.attachmentId);
        }
        appendedFiles.push(restored);
      }
      const capacity = remainingComposerAttachmentSlots(
        readAttachmentDraft().images.length + composerFilesNow.length,
        pendingThreadImportsRef.current.get(composerTargetKey(composerDraftTarget)) ?? 0,
      );
      const filesToAppend = appendedFiles.slice(0, capacity);
      const skippedFiles = appendedFiles.slice(capacity);
      unrestoredFileNames = skippedFiles.map((file) => file.name);
      // A non-durable take can resurrect the stash entry after a reload;
      // deleting these uploads would leave it pointing at nothing.
      if (durable) {
        for (const file of duplicateFiles) {
          releasePersistedAttachmentUpload({
            id: file.id,
            environmentId,
            attachmentId: file.attachmentId,
          });
        }
        for (const file of skippedFiles) {
          if (file.uploadedAttachmentId) {
            releasePersistedAttachmentUpload({
              id: file.id,
              environmentId,
              attachmentId: file.uploadedAttachmentId,
            });
          }
        }
      }
      const restoredFiles = [...markerReplacements, ...filesToAppend];
      if (restoredFiles.length > 0) {
        addComposerDraftFiles(composerDraftTarget, restoredFiles, { appendReference: true });
        const restoredFilePrompt = getComposerDraft(composerDraftTarget)?.prompt;
        if (restoredFilePrompt !== undefined && restoredFilePrompt !== promptRef.current) {
          promptRef.current = restoredFilePrompt;
          setComposerCursor(
            collapseExpandedComposerCursor(restoredFilePrompt, restoredFilePrompt.length),
          );
          setComposerTrigger(null);
          promptChanged = true;
        }
        restoredFileCount = filesToAppend.length;
      }
    }

    let unrestoredImageNames: string[] = [];
    if (entry.attachments.length > 0) {
      const attachmentDraft = readAttachmentDraft();
      const existingIds = new Set(attachmentDraft.images.map((image) => image.id));
      // The draft store also dedupes by mimeType+sizeBytes+name, so filter
      // on the same key here. Counting a duplicate against capacity would
      // burn a slot the store then refuses to fill, pushing a genuinely
      // unique image into the overflow list for nothing.
      const existingDedupKeys = new Set(
        attachmentDraft.images.map(
          (image) => `${image.mimeType}\0${image.sizeBytes}\0${image.name}`,
        ),
      );
      const capacity = remainingComposerAttachmentSlots(
        attachmentDraft.images.length + attachmentDraft.files.length + restoredFileCount,
        pendingThreadImportsRef.current.get(composerTargetKey(composerDraftTarget)) ?? 0,
      );
      const pending = entry.attachments.filter(
        (attachment) =>
          !existingIds.has(attachment.id) &&
          !existingDedupKeys.has(
            `${attachment.mimeType}\0${attachment.sizeBytes}\0${attachment.name}`,
          ),
      );
      unrestoredImageNames = pending.slice(capacity).map((attachment) => attachment.name);
      const restoredImages = hydrateImagesFromPersisted(pending.slice(0, capacity));
      if (restoredImages.length > 0) {
        addComposerDraftImages(composerDraftTarget, restoredImages);
      }
    }

    const missingImageReasons: string[] = [];
    if (entry.droppedImageNames.length > 0) {
      missingImageReasons.push(
        `${entry.droppedImageNames.join(", ")} exceeded the stash size limit when this prompt was saved.`,
      );
    }
    if (entry.unreadableImageNames && entry.unreadableImageNames.length > 0) {
      missingImageReasons.push(
        `${entry.unreadableImageNames.join(", ")} could not be read when this prompt was saved.`,
      );
    }
    if (unrestoredImageNames.length > 0) {
      missingImageReasons.push(
        `${unrestoredImageNames.join(", ")} could not be restored: the composer is at its ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-attachment limit.`,
      );
    }
    if (unrestoredFileNames.length > 0) {
      missingImageReasons.push(
        `${unrestoredFileNames.join(", ")} could not be restored: the composer is at its ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-attachment limit.`,
      );
    }
    if (expiredFileNames.length > 0) {
      missingImageReasons.push(
        `${expiredFileNames.join(", ")}: stashed files are kept for 24 hours and this upload expired. Attach the file again.`,
      );
    }
    if (missingImageReasons.length > 0) {
      toastManager.add({
        type: "warning",
        title: "Some attachments were not restored",
        description: missingImageReasons.join(" "),
      });
    }

    if (promptChanged) {
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAtEnd();
      });
    }
  };
  const restoreStashEntryStable = useStableCallback(restoreStashEntry);

  const deleteStashEntry = (entry: PromptStashEntry) => {
    const { entry: removed, durable } = takeStashEntry(entry.id);
    if (!stashQueue.some((candidate) => candidate.id !== entry.id)) {
      setIsStashMenuOpen(false);
    }
    if (durable && removed) {
      for (const file of removed.files ?? []) {
        releasePersistedAttachmentUpload({
          id: file.id,
          environmentId: file.environmentId,
          attachmentId: file.attachmentId,
        });
      }
    }
    if (!durable) {
      toastManager.add({
        type: "warning",
        title: "Stash entry may come back",
        description:
          "Browser storage rejected the delete, so this prompt could reappear after a reload.",
        data: { hideCopyButton: true },
      });
    }
  };
  const deleteStashEntryStable = useStableCallback(deleteStashEntry);

  const stashCurrentPrompt = async () => {
    // Stashing clears the draft. A pasted attachment still downloading would then land in the
    // emptied composer instead of travelling with the entry it belongs to.
    if (pendingDraftWork.has(attachmentTargetKey)) {
      toastManager.add({
        type: "info",
        title: "Still bringing attached context into this message.",
        description: "Stash again once its chip resolves.",
      });
      return;
    }
    const prompt = promptRef.current.trim();
    const attachmentDraft = readAttachmentDraft();
    const images = [...attachmentDraft.images];
    const files = [...attachmentDraft.files];
    const stashedRecords: ComposerContextRecord[] = [
      ...composerThreadContexts,
      ...readTerminalContexts().map(terminalContextRecord),
      ...composerReviewComments.map(reviewCommentContextRecord),
      ...composerPreviewAnnotations.map((annotation) =>
        previewAnnotationContextRecord(annotation, {
          screenshotContextId: images.some((image) => image.id === annotation.id)
            ? annotation.id
            : undefined,
        }),
      ),
    ];
    if (prompt.length === 0 && images.length === 0 && files.length === 0) {
      const entries = usePromptStashStore.getState().entries;
      const entry = entries.length === 1 ? entries[0] : undefined;
      if (entry && !entry.pendingImageCount) {
        await restoreStashEntry(entry);
      } else {
        setIsStashMenuOpen((open) => !open);
      }
      return;
    }
    const stashedFiles: PersistedComposerFileAttachment[] = [];
    for (const file of files) {
      if (composerFileNeedsReattach(file)) {
        toastManager.add({
          type: "error",
          title: "Attach dropped files again or remove them before stashing",
        });
        return;
      }
      const upload = readAttachmentUpload(file.id);
      if (upload?.status !== "ready" || upload.environmentId !== environmentId) {
        toastManager.add({
          type: "error",
          title: "Wait for file uploads before stashing this prompt",
        });
        return;
      }
      stashedFiles.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        attachmentId: upload.attachmentId,
        environmentId,
        ...(file.source ? { source: file.source } : {}),
      });
    }
    // Deduplicate the snapshot while encoding, not all stashes: new drafts or
    // thread switches must still be able to create their own entries.
    const attachmentKey = images
      .map((image) => `image:${image.id}`)
      .concat(files.map((file) => `file:${file.id}`))
      .join(",");
    const snapshotKey = [String(composerDraftTarget), prompt, attachmentKey].join("\n");
    if (stashInFlightRef.current.has(snapshotKey)) return;
    stashInFlightRef.current.add(snapshotKey);

    const stashTarget = composerDraftTarget;
    const entryId = randomUUID();
    const stashAndEncode = async () => {
      // Ordering matters in both directions: writing before clearing means a
      // crash or closed tab mid-encode still leaves the prompt recoverable,
      // while clearing before the async image work means edits typed during
      // encoding are not wiped.
      const { evicted, written, durable } = stashEntryToQueue({
        id: entryId,
        createdAt: new Date().toISOString(),
        prompt,
        attachments: [],
        ...(stashedFiles.length > 0 ? { files: stashedFiles } : {}),
        droppedImageNames: [],
        unreadableImageNames: [],
        pendingImageCount: images.length,
        ...(stashedRecords.length > 0 ? { records: stashedRecords } : {}),
      });

      // If it was rejected (quota) the store has already rolled itself back,
      // so leave the composer untouched rather than making it the second
      // casualty of a reload.
      if (!written) {
        toastManager.add({
          type: "error",
          title: "Could not stash this prompt",
          description:
            "Browser storage rejected the write, so the composer was left as-is. Free up site data and try again.",
          data: { hideCopyButton: true },
        });
        return;
      }
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stashed prompt will not survive a reload",
          description:
            "Browser storage is unavailable, so this stash is kept in memory only for this session.",
          data: { hideCopyButton: true },
        });
      }

      promptRef.current = "";
      clearComposerDraftPromptAndImages(stashTarget);
      clearComposerDraftTerminalContexts(stashTarget);
      setComposerDraftThreadContexts(stashTarget, []);
      for (const comment of composerReviewComments) {
        removeComposerDraftReviewComment(stashTarget, comment.id);
      }
      for (const annotation of composerPreviewAnnotations) {
        releaseAttachmentUpload(annotation.id);
        removeComposerDraftPreviewAnnotation(stashTarget, annotation.id);
      }
      setComposerDraftPrompt(stashTarget, "");
      for (const image of images) {
        releaseAttachmentUpload(image.id);
      }
      setComposerCursor(0);
      setComposerTrigger(null);
      pulseStashBadge();

      if (evicted) {
        for (const file of evicted.files ?? []) {
          releasePersistedAttachmentUpload({
            id: file.id,
            environmentId: file.environmentId,
            attachmentId: file.attachmentId,
          });
        }
        toastManager.add({
          type: "warning",
          title: "Oldest stashed prompt discarded",
          description: `The stash holds ${MAX_STASH_ENTRIES} prompts; the oldest was removed to make room.`,
          data: { hideCopyButton: true },
        });
      }

      // Images are re-encoded for the stash rather than stored verbatim: the
      // composer allows up to 10MB per image, but localStorage gives the whole
      // origin ~5MB.
      const candidateAttachments: PersistedComposerImageAttachment[] = [];
      const oversizedImageNames: string[] = [];
      const unreadableImageNames: string[] = [];
      for (const image of images) {
        const result = await compressImageForStash(image.file);
        if (!result.ok) {
          (result.reason === "too-large" ? oversizedImageNames : unreadableImageNames).push(
            image.name,
          );
          continue;
        }
        candidateAttachments.push({
          id: image.id,
          name: image.name,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
          dataUrl: result.image.dataUrl,
          ...(image.source
            ? { source: resizeSnapShotSource(image.source, result.image.imageSize) }
            : {}),
        });
      }
      const { kept, droppedNames } = partitionStashAttachments(candidateAttachments);

      const { attached, durable: imagesDurable } = finalizeStashEntryImages(entryId, {
        attachments: kept,
        droppedImageNames: [...oversizedImageNames, ...droppedNames],
        unreadableImageNames,
      });
      if (attached) {
        if (!imagesDurable && durable && images.length > 0) {
          toastManager.add({
            type: "warning",
            title: "Stashed images were not saved",
            description:
              "The prompt was stashed, but browser storage rejected its images. They will be missing if you reload.",
            data: { hideCopyButton: true },
          });
        }
      } else if (kept.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Stashed images did not attach",
          description: `That prompt was restored or deleted before ${kept.length} image${kept.length === 1 ? "" : "s"} finished saving. Re-attach ${kept.length === 1 ? "it" : "them"} if you still need ${kept.length === 1 ? "it" : "them"}.`,
          data: { hideCopyButton: true },
        });
      }
    };
    await stashAndEncode().finally(() => stashInFlightRef.current.delete(snapshotKey));
  };
  const stashCurrentPromptStable = useStableCallback(stashCurrentPrompt);

  const toggleStashMenu = () => {
    if (isComposerCollapsedMobile) {
      expandMobileComposer();
      setIsStashMenuOpen(true);
      return;
    }
    setIsStashMenuOpen((open) => !open);
  };
  const toggleStashMenuStable = useStableCallback(toggleStashMenu);

  const [stashMenuClosesOn, setStashMenuClosesOn] = useState({ prompt, composerMenuOpen });
  if (
    stashMenuClosesOn.prompt !== prompt ||
    stashMenuClosesOn.composerMenuOpen !== composerMenuOpen
  ) {
    setStashMenuClosesOn({ prompt, composerMenuOpen });
    if (stashMenuClosesOn.prompt !== prompt || composerMenuOpen) setIsStashMenuOpen(false);
  }

  // Read at event time, so the scope registers once per mounted composer instead of
  // re-registering (and reshuffling capture-scope priority) whenever a guard flips.
  const handleStashShortcut = useStableCallback((event: KeyboardEvent) => {
    // Always claim the shortcut so the browser save dialog never opens,
    // even when the composer is in a state that can't stash.
    event.preventDefault();
    event.stopPropagation();
    if (isCommandPaletteOpen() || isRevertingCheckpoint()) return;
    if (pendingUserInputs.length > 0) {
      setIsStashMenuOpen((open) => !open);
      return;
    }
    if (projectSelectionRequired || activePendingProgress !== null) return;
    void stashCurrentPromptStable();
  });
  // Capture phase while the composer is mounted, so Mod+S never reaches the browser's save
  // dialog even when a focused widget (the model picker search) stops the key.
  const backgroundThread = use(BackgroundThreadContext);
  const embeddedChat = use(EmbeddedChatContext);
  const readShortcutContext = useStableCallback(() => ({
    terminalOpen: Boolean(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        routeThreadRef,
      ).terminalOpen,
    ),
  }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the capture-phase stash shortcut with the command registry while the composer is mounted
  useEffect(() => {
    if (backgroundThread && !embeddedChat) return;
    return registerCommands(
      { "composer.stash": handleStashShortcut },
      {
        capture: true,
        context: readShortcutContext,
        when: (event) =>
          !isInSideChatPane(event.target) && isFromEmbeddedChat(event) === embeddedChat,
      },
    );
  }, [backgroundThread, embeddedChat, handleStashShortcut, readShortcutContext]);

  return {
    stashQueue,
    isStashMenuOpen,
    setIsStashMenuOpen,
    stashPulseKey,
    restoreStashEntryStable,
    deleteStashEntryStable,
    toggleStashMenuStable,
  };
}
