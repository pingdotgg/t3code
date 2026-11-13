import {
  ComposerDraftStoreGet,
  ComposerDraftStoreSet,
  ComposerDraftStoreState,
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerThreadDraftState,
  DraftId,
  composerFileNeedsReattach,
} from "./draftTypes";
import {
  composerFileDedupKey,
  composerFileMatchesReattachMarker,
  composerImageDedupKey,
  createEmptyThreadDraft,
  resolveComposerDraftKey,
  resolveComposerThreadId,
  revokeObjectPreviewUrl,
  shouldRemoveDraft,
} from "./draftStateHelpers";
import { verifyPersistedAttachments } from "./attachmentHydration";
import {
  stripInlineContextReferences,
  ensureInlineContextReferences,
  formatInlineContextReference,
  removeInlineContextReference,
} from "../lib/composerContextReferences";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  fileContextReference,
  previewAnnotationContextReference,
  reviewCommentContextReference,
  terminalContextReference,
  threadContextReference,
  environmentContextReference,
} from "../lib/composerContextRecords";
import {
  replaceComposerContextReferences,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";

export type ComposerAttachmentSlice = Pick<
  ComposerDraftStoreState,
  | "addImage"
  | "addImages"
  | "removeImage"
  | "addFiles"
  | "removeFile"
  | "setFileUpload"
  | "markFileUploadMissing"
  | "clearPersistedAttachments"
  | "syncPersistedAttachments"
  | "clearComposerContent"
  | "clearComposerPromptAndImages"
  | "moveComposerPromptAndImages"
>;

export function createComposerAttachmentSlice(
  set: ComposerDraftStoreSet,
  get: ComposerDraftStoreGet,
): ComposerAttachmentSlice {
  return {
      addImage: (threadRef, image) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        const threadId = resolveComposerThreadId(get(), threadRef);
        if (!threadKey || !threadId) {
          return false;
        }
        const acceptedIds = get().addImages(
          typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef,
          [image],
        );
        return acceptedIds.includes(image.id);
      },
      addImages: (threadRef, images, options) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0 || images.length === 0) {
          return [];
        }
        let acceptedIds: string[] = [];
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const existingIds = new Set(existing.images.map((image) => image.id));
          const existingDedupKeys = new Set(
            existing.images.map((image) => composerImageDedupKey(image)),
          );
          const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
          const dedupedIncoming: ComposerImageAttachment[] = [];
          for (const image of images) {
            const dedupKey = composerImageDedupKey(image);
            if (
              existingIds.has(image.id) ||
              (!options?.allowDuplicates && existingDedupKeys.has(dedupKey))
            ) {
              // Avoid revoking a blob URL that's still referenced by an accepted image.
              if (!acceptedPreviewUrls.has(image.previewUrl)) {
                revokeObjectPreviewUrl(image.previewUrl);
              }
              continue;
            }
            if (
              existing.images.length + existing.files.length + dedupedIncoming.length >=
              PROVIDER_SEND_TURN_MAX_ATTACHMENTS
            ) {
              if (!acceptedPreviewUrls.has(image.previewUrl)) {
                revokeObjectPreviewUrl(image.previewUrl);
              }
              continue;
            }
            dedupedIncoming.push(image);
            existingIds.add(image.id);
            existingDedupKeys.add(dedupKey);
            acceptedPreviewUrls.add(image.previewUrl);
          }
          if (dedupedIncoming.length === 0) {
            return state;
          }
          acceptedIds = dedupedIncoming.map((image) => image.id);
          return {
            draftsByThreadKey: {
              ...state.draftsByThreadKey,
              [threadKey]: {
                ...existing,
                images: [...existing.images, ...dedupedIncoming],
              },
            },
          };
        });
        return acceptedIds;
      },
      removeImage: (threadRef, imageId) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        const existing = get().draftsByThreadKey[threadKey];
        if (!existing) {
          return;
        }
        const removedImage = existing.images.find((image) => image.id === imageId);
        if (removedImage) {
          revokeObjectPreviewUrl(removedImage.previewUrl);
        }
        set((state) => {
          const current = state.draftsByThreadKey[threadKey];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            prompt: removeInlineContextReference(
              current.prompt,
              toKindScopedComposerContextId("image", imageId),
            ).prompt,
            images: current.images.filter((image) => image.id !== imageId),
            nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
            persistedAttachments: current.persistedAttachments.filter(
              (attachment) => attachment.id !== imageId,
            ),
          };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadKey[threadKey];
          } else {
            nextDraftsByThreadKey[threadKey] = nextDraft;
          }
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
      addFiles: (threadRef, files, options) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0 || files.length === 0) {
          return [];
        }
        let acceptedIds: string[] = [];
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const knownIds = new Set(existing.files.map((file) => file.id));
          const knownFiles = new Map<string, ComposerFileAttachment>(
            existing.files.map((file) => [composerFileDedupKey(file), file]),
          );
          const accepted: ComposerFileAttachment[] = [];
          const replacements = new Map<string, ComposerFileAttachment>();
          for (const file of files) {
            const key = composerFileDedupKey(file);
            if (knownIds.has(file.id)) {
              continue;
            }
            const duplicate = options?.allowDuplicates
              ? undefined
              : (knownFiles.get(key) ??
                existing.files.find(
                  (candidate) =>
                    composerFileNeedsReattach(candidate) &&
                    !replacements.has(candidate.id) &&
                    composerFileMatchesReattachMarker(candidate, file),
                ));
            if (duplicate) {
              if (composerFileNeedsReattach(duplicate) && !replacements.has(duplicate.id)) {
                replacements.set(duplicate.id, file);
                knownIds.add(file.id);
                knownFiles.set(key, file);
              }
              continue;
            }
            if (
              existing.images.length + existing.files.length + accepted.length >=
              PROVIDER_SEND_TURN_MAX_ATTACHMENTS
            ) {
              break;
            }
            accepted.push(file);
            knownIds.add(file.id);
            knownFiles.set(key, file);
          }
          if (accepted.length === 0 && replacements.size === 0) {
            return state;
          }
          acceptedIds = accepted.map((file) => file.id);
          const retained = existing.files.map((file) => replacements.get(file.id) ?? file);
          const prompt =
            replacements.size === 0
              ? existing.prompt
              : replaceComposerContextReferences(existing.prompt, (occurrence) => {
                  const original = existing.files.find(
                    (file) => fileContextReference(file).contextId === occurrence.contextId,
                  );
                  const replacement = original ? replacements.get(original.id) : undefined;
                  return replacement
                    ? formatInlineContextReference(fileContextReference(replacement))
                    : occurrence.source;
                });
          return {
            draftsByThreadKey: {
              ...state.draftsByThreadKey,
              [threadKey]: {
                ...existing,
                prompt: options?.appendReference
                  ? ensureInlineContextReferences(
                      prompt,
                      [...accepted, ...replacements.values()].map(fileContextReference),
                    )
                  : prompt,
                files: [...retained, ...accepted],
              },
            },
          };
        });
        return acceptedIds;
      },
      removeFile: (threadRef, fileId) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadKey[threadKey];
          if (!current?.files.some((file) => file.id === fileId)) {
            return state;
          }
          const nextDraft = {
            ...current,
            prompt: removeInlineContextReference(
              current.prompt,
              toKindScopedComposerContextId("file", fileId),
            ).prompt,
            files: current.files.filter((file) => file.id !== fileId),
          } satisfies ComposerThreadDraftState;
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadKey[threadKey];
          } else {
            nextDraftsByThreadKey[threadKey] = nextDraft;
          }
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
      setFileUpload: (threadRef, fileId, environmentId, attachmentId) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadKey[threadKey];
          const file = current?.files.find((entry) => entry.id === fileId);
          if (
            !current ||
            !file ||
            (file.uploadEnvironmentId === environmentId &&
              file.uploadedAttachmentId === attachmentId)
          ) {
            return state;
          }
          return {
            draftsByThreadKey: {
              ...state.draftsByThreadKey,
              [threadKey]: {
                ...current,
                files: current.files.map((entry) =>
                  entry.id === fileId
                    ? {
                        ...entry,
                        uploadedAttachmentId: attachmentId,
                        uploadEnvironmentId: environmentId,
                      }
                    : entry,
                ),
              },
            },
          };
        });
      },
      markFileUploadMissing: (threadRef, fileId, environmentId, attachmentId) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return false;
        }
        let markedMissing = false;
        set((state) => {
          const current = state.draftsByThreadKey[threadKey];
          const file = current?.files.find((entry) => entry.id === fileId);
          if (
            !current ||
            !file ||
            file.file !== null ||
            file.uploadEnvironmentId !== environmentId ||
            file.uploadedAttachmentId !== attachmentId
          ) {
            return state;
          }
          markedMissing = true;
          return {
            draftsByThreadKey: {
              ...state.draftsByThreadKey,
              [threadKey]: {
                ...current,
                files: current.files.map((entry) => {
                  if (entry.id !== fileId) {
                    return entry;
                  }
                  const marker = { ...entry };
                  delete marker.uploadedAttachmentId;
                  delete marker.uploadEnvironmentId;
                  return marker;
                }),
              },
            },
          };
        });
        return markedMissing;
      },
      clearPersistedAttachments: (threadRef) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadKey[threadKey];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            persistedAttachments: [],
            nonPersistedImageIds: [],
          };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadKey[threadKey];
          } else {
            nextDraftsByThreadKey[threadKey] = nextDraft;
          }
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
      syncPersistedAttachments: async (threadRef, attachments) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey) {
          return;
        }
        const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
        set((state) => {
          const current = state.draftsByThreadKey[threadKey];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            persistedAttachments: attachments,
            nonPersistedImageIds: current.nonPersistedImageIds.filter(
              (id) => !attachmentIdSet.has(id),
            ),
          };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadKey[threadKey];
          } else {
            nextDraftsByThreadKey[threadKey] = nextDraft;
          }
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
        await Promise.resolve();
        verifyPersistedAttachments(threadKey, attachments, set);
      },
      clearComposerContent: (threadRef) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadKey[threadKey];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            prompt: "",
            images: [],
            files: [],
            nonPersistedImageIds: [],
            persistedAttachments: [],
            terminalContexts: [],
            previewAnnotations: [],
            reviewComments: [],
            threadContexts: [],
            environmentContexts: [],
          };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadKey[threadKey];
          } else {
            nextDraftsByThreadKey[threadKey] = nextDraft;
          }
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
      clearComposerPromptAndImages: (threadRef) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadKey[threadKey];
          if (!current) {
            return state;
          }
          for (const image of current.images) {
            revokeObjectPreviewUrl(image.previewUrl);
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            prompt: ensureInlineContextReferences("", [
              ...current.terminalContexts.map(terminalContextReference),
              ...current.reviewComments.map(reviewCommentContextReference),
              ...current.threadContexts.map(threadContextReference),
              ...current.environmentContexts.map(environmentContextReference),
              ...current.previewAnnotations.map(previewAnnotationContextReference),
            ]),
            images: [],
            files: [],
            nonPersistedImageIds: [],
            persistedAttachments: [],
          };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadKey[threadKey];
          } else {
            nextDraftsByThreadKey[threadKey] = nextDraft;
          }
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
      moveComposerPromptAndImages: (from, to) => {
        const fromKey = resolveComposerDraftKey(get(), from) ?? "";
        const toKey = resolveComposerDraftKey(get(), to) ?? "";
        if (fromKey.length === 0 || toKey.length === 0 || fromKey === toKey) {
          return;
        }
        set((state) => {
          const source = state.draftsByThreadKey[fromKey];
          if (!source) {
            return state;
          }
          const destination = state.draftsByThreadKey[toKey] ?? createEmptyThreadDraft();
          const destinationEnvironmentId =
            typeof to === "string"
              ? (state.draftThreadsByThreadKey[toKey]?.environmentId ??
                parseScopedThreadKey(toKey)?.environmentId ??
                null)
              : to.environmentId;
          const destinationFileIds = new Set(destination.files.map((file) => file.id));
          const destinationFileKeys = new Set(destination.files.map(composerFileDedupKey));
          const transferableFiles = source.files.filter(
            (file) =>
              (file.file !== null || file.uploadEnvironmentId === destinationEnvironmentId) &&
              !destinationFileIds.has(file.id) &&
              !destinationFileKeys.has(composerFileDedupKey(file)),
          );
          const remainingAttachmentSlots = Math.max(
            0,
            PROVIDER_SEND_TURN_MAX_ATTACHMENTS -
              destination.images.length -
              destination.files.length,
          );
          const movedImages = source.images.slice(0, remainingAttachmentSlots);
          const movedImageIds = new Set(movedImages.map((image) => image.id));
          const retainedImages = source.images.filter((image) => !movedImageIds.has(image.id));
          const movedFiles = transferableFiles
            .slice(0, remainingAttachmentSlots - movedImages.length)
            .map((file) => {
              // Re-upload local bytes across environments; the destination cannot reach source upload ids.
              if (
                file.file === null ||
                file.uploadEnvironmentId === undefined ||
                file.uploadEnvironmentId === destinationEnvironmentId
              ) {
                return file;
              }
              const { uploadedAttachmentId: _a, uploadEnvironmentId: _e, ...rest } = file;
              return rest;
            });
          const movedFileIds = new Set(movedFiles.map((file) => file.id));
          const retainedFiles = source.files.filter((file) => !movedFileIds.has(file.id));
          const movedPrompt = ensureInlineContextReferences(
            stripInlineContextReferences(source.prompt),
            destination.terminalContexts.map(terminalContextReference),
          );
          const nextDestination: ComposerThreadDraftState = {
            ...destination,
            prompt: movedPrompt,
            images: [...destination.images, ...movedImages],
            files: [...destination.files, ...movedFiles],
            nonPersistedImageIds: [
              ...destination.nonPersistedImageIds,
              ...source.nonPersistedImageIds.filter((imageId) => movedImageIds.has(imageId)),
            ],
            persistedAttachments: [
              ...destination.persistedAttachments,
              ...source.persistedAttachments.filter((attachment) =>
                movedImageIds.has(attachment.id),
              ),
            ],
          };
          // Moved images still use these blob URLs at the destination; do not revoke them.
          const nextSource: ComposerThreadDraftState = {
            ...source,
            prompt: ensureInlineContextReferences(
              "",
              source.terminalContexts.map(terminalContextReference),
            ),
            images: retainedImages,
            files: retainedFiles,
            nonPersistedImageIds: source.nonPersistedImageIds.filter(
              (imageId) => !movedImageIds.has(imageId),
            ),
            persistedAttachments: source.persistedAttachments.filter(
              (attachment) => !movedImageIds.has(attachment.id),
            ),
          };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextSource)) {
            delete nextDraftsByThreadKey[fromKey];
          } else {
            nextDraftsByThreadKey[fromKey] = nextSource;
          }
          if (shouldRemoveDraft(nextDestination)) {
            delete nextDraftsByThreadKey[toKey];
          } else {
            nextDraftsByThreadKey[toKey] = nextDestination;
          }
          return { draftsByThreadKey: nextDraftsByThreadKey };
        });
      },
  };
}
