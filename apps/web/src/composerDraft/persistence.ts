import {
  COMPOSER_PERSIST_DEBOUNCE_MS,
  ComposerDraftStoreState,
  LegacyPersistedComposerDraftStoreState,
  PersistedComposerDraftStoreState,
  PersistedComposerThreadDraftState,
  composerDraftHasUserContent,
} from "./draftTypes";
import {
  EMPTY_PERSISTED_DRAFT_STORE_STATE,
  draftThreadHasOpenPreview,
  isDraftThreadPromoting,
} from "./draftStateHelpers";
import {
  compactModelSelectionByProvider,
  compactStickyOptionsByModel,
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyToModelSelectionByProvider,
  normalizeModelSelection,
  normalizeProviderInstanceId,
  normalizeProviderModelOptions,
  seedStickyOptionsByModel,
} from "./modelSelectionNormalization";
import {
  normalizePersistedDraftThreads,
  normalizePersistedDraftsByThreadId,
  normalizePersistedModelSelectionByProvider,
  stripLegacyModelSeedsFromEmptyDraftSessions,
} from "./persistedDraftNormalization";
import {
  ModelSelection,
  ProviderInstanceId,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import { DeepMutable } from "effect/Types";
import { type PersistStorage, type StorageValue } from "zustand/middleware";
import { createDeferredStorage, createMemoryStorage } from "../lib/storage";

export type ComposerPersistState =
  | { capturedState: ComposerDraftStoreState }
  | PersistedComposerDraftStoreState;

export const composerDebouncedStorage = createDeferredStorage<StorageValue<ComposerPersistState>>(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  (value) =>
    JSON.stringify({
      state:
        "capturedState" in value.state
          ? partializeComposerDraftStoreState(value.state.capturedState)
          : value.state,
      version: value.version,
    }),
  COMPOSER_PERSIST_DEBOUNCE_MS,
);

export const composerPersistStorage: PersistStorage<ComposerPersistState> = {
  getItem: (name) => {
    const raw = composerDebouncedStorage.getItem(name);
    if (typeof raw !== "string") {
      return null;
    }
    return JSON.parse(raw) as StorageValue<ComposerPersistState>;
  },
  setItem: (name, value) => composerDebouncedStorage.setItem(name, value),
  removeItem: (name) => composerDebouncedStorage.removeItem(name),
};

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}
export function migratePersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  const normalized = normalizeCurrentPersistedComposerDraftStoreState(persistedState);
  return {
    ...normalized,
    draftsByThreadKey: stripLegacyModelSeedsFromEmptyDraftSessions(
      normalized.draftsByThreadKey,
      normalized.draftThreadsByThreadKey,
    ),
  };
}

export function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  const mappedDraftKeys = new Set(
    Object.values(state.logicalProjectDraftThreadKeyByLogicalProjectKey),
  );
  const keptSessionKeys = new Set(
    Object.entries(state.draftThreadsByThreadKey)
      .filter(
        ([threadKey, draftThread]) =>
          mappedDraftKeys.has(threadKey) ||
          isDraftThreadPromoting(draftThread) ||
          composerDraftHasUserContent(state.draftsByThreadKey[threadKey]) ||
          draftThreadHasOpenPreview(draftThread),
      )
      .map(([threadKey]) => threadKey),
  );
  const persistedDraftsByThreadKey: DeepMutable<
    PersistedComposerDraftStoreState["draftsByThreadKey"]
  > = {};
  for (const [threadKey, draft] of Object.entries(state.draftsByThreadKey)) {
    if (typeof threadKey !== "string" || threadKey.length === 0) {
      continue;
    }
    if (state.draftThreadsByThreadKey[threadKey] !== undefined && !keptSessionKeys.has(threadKey)) {
      continue;
    }
    const hasModelData =
      Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null;
    if (
      draft.prompt.length === 0 &&
      draft.persistedAttachments.length === 0 &&
      draft.files.length === 0 &&
      draft.terminalContexts.length === 0 &&
      draft.previewAnnotations.length === 0 &&
      draft.reviewComments.length === 0 &&
      draft.threadContexts.length === 0 &&
      draft.environmentContexts.length === 0 &&
      !hasModelData &&
      draft.runtimeMode === null &&
      draft.interactionMode === null
    ) {
      continue;
    }
    const persistedDraft: DeepMutable<PersistedComposerThreadDraftState> = {
      prompt: draft.prompt,
      attachments: draft.persistedAttachments,
      ...(draft.files.length > 0
        ? {
            files: draft.files.map((file) => ({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
              ...(file.source ? { source: file.source } : {}),
              ...(file.uploadedAttachmentId && file.uploadEnvironmentId
                ? {
                    attachmentId: file.uploadedAttachmentId,
                    environmentId: file.uploadEnvironmentId,
                  }
                : {}),
            })),
          }
        : {}),
      ...(draft.terminalContexts.length > 0
        ? {
            terminalContexts: draft.terminalContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              createdAt: context.createdAt,
              terminalId: context.terminalId,
              terminalLabel: context.terminalLabel,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
              text: context.text,
            })),
          }
        : {}),
      ...(draft.previewAnnotations.length > 0
        ? {
            previewAnnotations: draft.previewAnnotations.map(
              (annotation) => ({ ...annotation }) as DeepMutable<PreviewAnnotationPayload>,
            ),
          }
        : {}),
      ...(draft.reviewComments.length > 0
        ? {
            reviewComments: draft.reviewComments.map((comment) => ({ ...comment })),
          }
        : {}),
      ...(draft.threadContexts.length > 0
        ? { threadContexts: draft.threadContexts.map((record) => ({ ...record })) }
        : {}),
      ...(draft.environmentContexts.length > 0
        ? { environmentContexts: draft.environmentContexts.map((record) => ({ ...record })) }
        : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(
              draft.modelSelectionByProvider,
            ),
            activeProvider: draft.activeProvider,
            ...(draft.modelSelectionExplicit ? { modelSelectionExplicit: true } : {}),
          }
        : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
    };
    persistedDraftsByThreadKey[threadKey] = persistedDraft;
  }
  const persistedDraftThreadsByThreadKey: DeepMutable<
    PersistedComposerDraftStoreState["draftThreadsByThreadKey"]
  > = {};
  for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
    if (!keptSessionKeys.has(threadKey)) {
      continue;
    }
    persistedDraftThreadsByThreadKey[threadKey] = draftThread;
  }
  return {
    draftsByThreadKey: persistedDraftsByThreadKey,
    draftThreadsByThreadKey: persistedDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(
      state.stickyModelSelectionByProvider,
    ),
    stickyOptionsByModelByProvider: compactStickyOptionsByModel(
      state.stickyOptionsByModelByProvider,
    ),
    stickyActiveProvider: state.stickyActiveProvider,
  };
}

export function normalizeCurrentPersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const normalizedPersistedState = persistedState as LegacyPersistedComposerDraftStoreState;
  const { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey } =
    normalizePersistedDraftThreads(
      normalizedPersistedState.draftThreadsByThreadKey ??
        normalizedPersistedState.draftThreadsByThreadId,
      normalizedPersistedState.logicalProjectDraftThreadKeyByLogicalProjectKey ??
        normalizedPersistedState.projectDraftThreadKeyByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectId,
    );

  let stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
  let stickyActiveProvider: ProviderInstanceId | null = null;
  if (
    normalizedPersistedState.stickyModelSelectionByProvider &&
    typeof normalizedPersistedState.stickyModelSelectionByProvider === "object"
  ) {
    stickyModelSelectionByProvider = normalizePersistedModelSelectionByProvider(
      normalizedPersistedState.stickyModelSelectionByProvider,
    );
    stickyActiveProvider = normalizeProviderInstanceId(
      normalizedPersistedState.stickyActiveProvider,
    );
  } else {
    const stickyModelOptions =
      normalizeProviderModelOptions(normalizedPersistedState.stickyModelOptions) ?? {};
    const normalizedStickyModelSelection = normalizeModelSelection(
      normalizedPersistedState.stickyModelSelection,
      {
        provider: normalizedPersistedState.stickyProvider ?? "codex",
        model: normalizedPersistedState.stickyModel,
        modelOptions: stickyModelOptions,
      },
    );
    const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
      normalizedStickyModelSelection,
      stickyModelOptions,
    );
    const stickyModelSelection = legacySyncModelSelectionOptions(
      normalizedStickyModelSelection,
      nextStickyModelOptions,
    );
    stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
      stickyModelSelection,
      nextStickyModelOptions,
    );
    stickyActiveProvider = normalizeProviderInstanceId(normalizedPersistedState.stickyProvider);
  }

  return {
    draftsByThreadKey: normalizePersistedDraftsByThreadId(
      normalizedPersistedState.draftsByThreadKey ?? normalizedPersistedState.draftsByThreadId,
      draftThreadsByThreadKey,
    ),
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(stickyModelSelectionByProvider),
    stickyOptionsByModelByProvider:
      normalizedPersistedState.stickyOptionsByModelByProvider === undefined
        ? seedStickyOptionsByModel(stickyModelSelectionByProvider)
        : compactStickyOptionsByModel(normalizedPersistedState.stickyOptionsByModelByProvider),
    stickyActiveProvider,
  };
}
