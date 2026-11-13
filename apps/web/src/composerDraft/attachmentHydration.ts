import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  ComposerDraftStoreState,
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerThreadDraftState,
  DraftThreadState,
  PersistedComposerDraftStoreStorage,
  PersistedComposerImageAttachment,
  PersistedComposerThreadDraftState,
  PersistedDraftThreadState,
} from "./draftTypes";
import { composerDebouncedStorage } from "./persistence";
import { normalizeProviderInstanceId } from "./modelSelectionNormalization";
import { projectDraftKey, shouldRemoveDraft } from "./draftStateHelpers";
import { EnvironmentId, ModelSelection, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import { ensureInlineContextReferences } from "../lib/composerContextReferences";
import {
  fileContextReference,
  previewAnnotationContextReference,
  reviewCommentContextReference,
  threadContextReference,
  environmentContextReference,
} from "../lib/composerContextRecords";

export function readPersistedAttachmentIdsFromStorage(threadKey: string): string[] {
  if (threadKey.length === 0) {
    return [];
  }
  try {
    const persisted = getLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      PersistedComposerDraftStoreStorage,
    );
    if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION) {
      return [];
    }
    return (persisted.state.draftsByThreadKey[threadKey]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

export function verifyPersistedAttachments(
  threadKey: string,
  attachments: PersistedComposerImageAttachment[],
  set: (
    partial:
      | ComposerDraftStoreState
      | Partial<ComposerDraftStoreState>
      | ((
          state: ComposerDraftStoreState,
        ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
    replace?: false,
  ) => void,
): void {
  let persistedIdSet = new Set<string>();
  try {
    composerDebouncedStorage.flush();
    persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadKey));
  } catch {
    persistedIdSet = new Set();
  }
  set((state) => {
    const current = state.draftsByThreadKey[threadKey];
    if (!current) {
      return state;
    }
    const imageIdSet = new Set(current.images.map((image) => image.id));
    const persistedAttachments = attachments.filter(
      (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
    );
    const nonPersistedImageIds: string[] = [];
    for (const image of current.images) {
      if (!persistedIdSet.has(image.id)) {
        nonPersistedImageIds.push(image.id);
      }
    }
    const nextDraft: ComposerThreadDraftState = {
      ...current,
      persistedAttachments,
      nonPersistedImageIds,
    };
    const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
    if (shouldRemoveDraft(nextDraft)) {
      delete nextDraftsByThreadKey[threadKey];
    } else {
      nextDraftsByThreadKey[threadKey] = nextDraft;
    }
    return { draftsByThreadKey: nextDraftsByThreadKey };
  });
}

export function hydratePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  const commaIndex = attachment.dataUrl.indexOf(",");
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : attachment.dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;
      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}

export function hydrateImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = hydratePersistedComposerImageAttachment(attachment);
    if (!file) return [];

    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.dataUrl,
        file,
        ...(attachment.source ? { source: attachment.source } : {}),
      } satisfies ComposerImageAttachment,
    ];
  });
}

export function toHydratedThreadDraft(
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState {
  const modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> =
    persistedDraft.modelSelectionByProvider ?? {};
  const activeProvider = normalizeProviderInstanceId(persistedDraft.activeProvider) ?? null;
  const files: ComposerFileAttachment[] =
    persistedDraft.files?.map((file) => ({
      type: "file" as const,
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      file: null,
      ...(file.source ? { source: file.source } : {}),
      ...(file.attachmentId !== undefined && file.environmentId !== undefined
        ? { uploadedAttachmentId: file.attachmentId, uploadEnvironmentId: file.environmentId }
        : {}),
    })) ?? [];

  return {
    prompt: ensureInlineContextReferences(persistedDraft.prompt, [
      ...(persistedDraft.reviewComments ?? []).map(reviewCommentContextReference),
      ...(persistedDraft.previewAnnotations ?? []).map(previewAnnotationContextReference),
      ...(persistedDraft.threadContexts ?? []).map(threadContextReference),
      ...(persistedDraft.environmentContexts ?? []).map(environmentContextReference),
      ...files.map(fileContextReference),
    ]),
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    files,
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: context.text ?? "",
      })) ?? [],
    previewAnnotations:
      persistedDraft.previewAnnotations?.map((annotation) => ({ ...annotation })) ?? [],
    reviewComments: persistedDraft.reviewComments?.map((comment) => ({ ...comment })) ?? [],
    threadContexts: persistedDraft.threadContexts?.map((record) => ({ ...record })) ?? [],
    environmentContexts: persistedDraft.environmentContexts?.map((record) => ({ ...record })) ?? [],
    modelSelectionByProvider,
    activeProvider,
    ...(persistedDraft.modelSelectionExplicit ? { modelSelectionExplicit: true } : {}),
    runtimeMode: persistedDraft.runtimeMode ?? null,
    interactionMode: persistedDraft.interactionMode ?? null,
  };
}

export function toHydratedDraftThreadState(
  persistedDraftThread: PersistedDraftThreadState,
): DraftThreadState {
  return {
    threadId: persistedDraftThread.threadId,
    environmentId: persistedDraftThread.environmentId as EnvironmentId,
    projectId: persistedDraftThread.projectId,
    logicalProjectKey:
      persistedDraftThread.logicalProjectKey ??
      projectDraftKey(
        scopeProjectRef(
          persistedDraftThread.environmentId as EnvironmentId,
          persistedDraftThread.projectId,
        ),
      ),
    createdAt: persistedDraftThread.createdAt,
    runtimeMode: persistedDraftThread.runtimeMode,
    interactionMode: persistedDraftThread.interactionMode,
    branch: persistedDraftThread.branch,
    worktreePath: persistedDraftThread.worktreePath,
    envMode: persistedDraftThread.envMode,
    startFromOrigin: persistedDraftThread.startFromOrigin,
    ...(persistedDraftThread.environmentSelection
      ? { environmentSelection: persistedDraftThread.environmentSelection }
      : {}),
    ...(persistedDraftThread.loadBalancedEnvironmentId !== undefined
      ? {
          loadBalancedEnvironmentId:
            persistedDraftThread.loadBalancedEnvironmentId as EnvironmentId | null,
        }
      : {}),
    promotedTo: persistedDraftThread.promotedTo
      ? scopeThreadRef(
          persistedDraftThread.promotedTo.environmentId as EnvironmentId,
          persistedDraftThread.promotedTo.threadId as ThreadId,
        )
      : null,
  };
}
