import {
  RuntimeMode,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  ComposerDraftStoreGet,
  ComposerDraftStoreSet,
  ComposerDraftStoreState,
  ComposerThreadDraftState,
} from "./draftTypes";
import {
  compactModelSelectionByProvider,
  normalizeModelSelection,
  normalizeProviderDriverKind,
} from "./modelSelectionNormalization";
import {
  createEmptyThreadDraft,
  normalizeTerminalContextsForThread,
  resolveComposerDraftKey,
  resolveComposerThreadId,
  shouldRemoveDraft,
} from "./draftStateHelpers";
import { createModelSelection, normalizeCustomModelSlug } from "@t3tools/shared/model";
import {
  ensureInlineContextReferences,
  removeInlineContextReference,
} from "../lib/composerContextReferences";
import { terminalContextReference } from "../lib/composerContextRecords";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";

const isRuntimeMode = Schema.is(RuntimeMode);
export type ComposerModelSlice = Pick<
  ComposerDraftStoreState,
  | "setStickyModelSelection"
  | "applyStickyState"
  | "setPrompt"
  | "setTerminalContexts"
  | "setModelSelection"
  | "setProviderModelOptions"
  | "setRuntimeMode"
  | "setInteractionMode"
>;

export function createComposerModelSlice(
  set: ComposerDraftStoreSet,
  get: ComposerDraftStoreGet,
): ComposerModelSlice {
  return {
      setStickyModelSelection: (modelSelection) => {
        const normalized = normalizeModelSelection(modelSelection);
        set((state) => {
          if (!normalized) {
            return state;
          }
          const current = state.stickyModelSelectionByProvider[normalized.instanceId];
          // Model-only updates omit options; preserve sticky traits across model switches and new chats.
          const nextSelection =
            normalized.options !== undefined
              ? normalized
              : createModelSelection(normalized.instanceId, normalized.model, current?.options);
          const nextMap: Partial<Record<ProviderInstanceId, ModelSelection>> = {
            ...state.stickyModelSelectionByProvider,
            [normalized.instanceId]: nextSelection,
          };
          if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
            return state.stickyActiveProvider === normalized.instanceId
              ? state
              : { stickyActiveProvider: normalized.instanceId };
          }
          return {
            stickyModelSelectionByProvider: nextMap,
            stickyActiveProvider: normalized.instanceId,
          };
        });
      },
      applyStickyState: (threadRef) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        set((state) => {
          const stickyMap = state.stickyModelSelectionByProvider;
          const stickyActiveProvider = state.stickyActiveProvider;
          const existing = state.draftsByThreadKey[threadKey];
          const base = existing ?? createEmptyThreadDraft();
          const nextMap = compactModelSelectionByProvider(stickyMap);
          if (
            Equal.equals(base.modelSelectionByProvider, nextMap) &&
            base.activeProvider === stickyActiveProvider &&
            base.modelSelectionExplicit === undefined
          ) {
            return state;
          }
          const { modelSelectionExplicit: _modelSelectionExplicit, ...retained } = base;
          const nextDraft: ComposerThreadDraftState = {
            ...retained,
            modelSelectionByProvider: nextMap,
            activeProvider: stickyActiveProvider,
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
      setPrompt: (threadRef, prompt) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt,
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
      setTerminalContexts: (threadRef, contexts) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        const threadId = resolveComposerThreadId(get(), threadRef);
        if (!threadKey || !threadId) {
          return;
        }
        const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt: ensureInlineContextReferences(
              existing.terminalContexts
                .filter((context) => !normalizedContexts.some((next) => next.id === context.id))
                .reduce(
                  (prompt, context) =>
                    removeInlineContextReference(
                      prompt,
                      terminalContextReference(context).contextId,
                    ).prompt,
                  existing.prompt,
                ),
              normalizedContexts.map(terminalContextReference),
            ),
            terminalContexts: normalizedContexts,
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
      setModelSelection: (threadRef, modelSelection, opts) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        const normalized = normalizeModelSelection(modelSelection);
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey];
          if (!existing && normalized === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          const nextMap = { ...base.modelSelectionByProvider };
          if (normalized) {
            const current = nextMap[normalized.instanceId];
            if (normalized.options !== undefined || opts?.replaceOptions) {
              nextMap[normalized.instanceId] = normalized as ModelSelection;
            } else {
              nextMap[normalized.instanceId] = createModelSelection(
                normalized.instanceId,
                normalized.model,
                current?.options,
              );
            }
          }
          const nextActiveProvider = normalized?.instanceId ?? base.activeProvider;
          if (
            Equal.equals(base.modelSelectionByProvider, nextMap) &&
            base.activeProvider === nextActiveProvider &&
            (base.modelSelectionExplicit ?? false) === (opts?.explicit === true)
          ) {
            return state;
          }
          const { modelSelectionExplicit: _previousExplicit, ...restBase } = base;
          const nextDraft: ComposerThreadDraftState = {
            ...restBase,
            modelSelectionByProvider: nextMap,
            activeProvider: nextActiveProvider,
            ...(opts?.explicit === true ? { modelSelectionExplicit: true as const } : {}),
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
      setProviderModelOptions: (threadRef, provider, nextProviderOptions, options) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        const normalizedProvider = normalizeProviderDriverKind(provider);
        if (normalizedProvider === null) {
          return;
        }
        const instanceKey = options?.instanceId ?? defaultInstanceIdForDriver(normalizedProvider);
        const fallbackModel =
          normalizeCustomModelSlug(options?.model) ??
          DEFAULT_MODEL_BY_PROVIDER[normalizedProvider] ??
          DEFAULT_MODEL;
        const providerOpts =
          nextProviderOptions && nextProviderOptions.length > 0 ? nextProviderOptions : undefined;

        set((state) => {
          const existing = state.draftsByThreadKey[threadKey];
          const base = existing ?? createEmptyThreadDraft();

          const nextMap = { ...base.modelSelectionByProvider };
          const currentForProvider = nextMap[instanceKey];
          if (providerOpts) {
            nextMap[instanceKey] = createModelSelection(
              instanceKey,
              currentForProvider?.model ?? fallbackModel,
              providerOpts,
            );
          } else if (currentForProvider && (currentForProvider.options?.length ?? 0) > 0) {
            const { options: _, ...rest } = currentForProvider;
            nextMap[instanceKey] = rest as ModelSelection;
          }

          let nextStickyMap = state.stickyModelSelectionByProvider;
          let nextOptionsByModel = state.stickyOptionsByModelByProvider;
          let nextStickyActiveProvider = state.stickyActiveProvider;
          if (options?.persistSticky === true) {
            nextStickyMap = { ...state.stickyModelSelectionByProvider };
            const stickyBase =
              nextStickyMap[instanceKey] ??
              base.modelSelectionByProvider[instanceKey] ??
              createModelSelection(instanceKey, fallbackModel);
            const rememberedModel = normalizeCustomModelSlug(options?.model) ?? stickyBase.model;
            if (providerOpts) {
              nextStickyMap[instanceKey] = createModelSelection(
                instanceKey,
                stickyBase.model,
                providerOpts,
              );
              nextOptionsByModel = {
                ...state.stickyOptionsByModelByProvider,
                [instanceKey]: {
                  ...state.stickyOptionsByModelByProvider[instanceKey],
                  [rememberedModel]: providerOpts,
                },
              };
            } else if ((stickyBase.options?.length ?? 0) > 0) {
              const { options: _, ...rest } = stickyBase;
              nextStickyMap[instanceKey] = rest as ModelSelection;
              const rememberedByModel = {
                ...state.stickyOptionsByModelByProvider[instanceKey],
              };
              delete rememberedByModel[rememberedModel];
              nextOptionsByModel = {
                ...state.stickyOptionsByModelByProvider,
                [instanceKey]: rememberedByModel,
              };
            }
            nextStickyActiveProvider = options.instanceId
              ? instanceKey
              : (base.activeProvider ?? instanceKey);
          }

          if (
            Equal.equals(base.modelSelectionByProvider, nextMap) &&
            Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
            Equal.equals(state.stickyOptionsByModelByProvider, nextOptionsByModel) &&
            state.stickyActiveProvider === nextStickyActiveProvider
          ) {
            return state;
          }

          const { modelSelectionExplicit: _previousExplicit, ...restBase } = base;
          const nextDraft: ComposerThreadDraftState = {
            ...restBase,
            ...(options?.instanceId ? { activeProvider: instanceKey } : {}),
            modelSelectionByProvider: nextMap,
            modelSelectionExplicit: true,
          };
          const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadKey[threadKey];
          } else {
            nextDraftsByThreadKey[threadKey] = nextDraft;
          }

          return {
            draftsByThreadKey: nextDraftsByThreadKey,
            ...(options?.persistSticky === true
              ? {
                  stickyModelSelectionByProvider: nextStickyMap,
                  stickyOptionsByModelByProvider: nextOptionsByModel,
                  stickyActiveProvider: nextStickyActiveProvider,
                }
              : {}),
          };
        });
      },
      setRuntimeMode: (threadRef, runtimeMode) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        const nextRuntimeMode = isRuntimeMode(runtimeMode) ? runtimeMode : null;
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey];
          if (!existing && nextRuntimeMode === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.runtimeMode === nextRuntimeMode) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            runtimeMode: nextRuntimeMode,
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
      setInteractionMode: (threadRef, interactionMode) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        const nextInteractionMode =
          interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
        set((state) => {
          const existing = state.draftsByThreadKey[threadKey];
          if (!existing && nextInteractionMode === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.interactionMode === nextInteractionMode) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            interactionMode: nextInteractionMode,
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
  };
}
