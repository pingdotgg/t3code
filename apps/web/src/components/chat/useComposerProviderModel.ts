import {
  type DraftId,
  deriveEffectiveComposerModelState,
  useComposerDraftModelState,
} from "../../composerDraftStore";
import { draftModelSelectionApplies } from "../../lib/chatThreadActions";
import {
  type ModelSelection,
  type ProjectId,
  ProviderDriverKind,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  NO_PROVIDER_MODEL_SELECTION,
  providerInstanceEntriesFor,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { getComposerPromptInjectionState, getComposerProviderState } from "./composerProviderState";
import { resolveComposerProviderSelection } from "../ChatView.logic";

const NO_PROVIDER_MODELS: ServerProvider["models"] = [];

type ComposerProviderModelInput = Omit<
  Parameters<typeof resolveComposerProviderSelection>[0],
  "entries"
> & {
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly activeProjectId: ProjectId | null;
  readonly threadRef: ScopedThreadRef | DraftId;
  readonly threadModelSelection: ModelSelection | null | undefined;
  readonly projectModelSelection: ModelSelection | null | undefined;
  readonly promptInjectionState: ReturnType<typeof getComposerPromptInjectionState>;
  readonly threadStarted: boolean;
};

function resolveComposerProviderModel(
  input: ComposerProviderModelInput,
  draftModelState: ReturnType<typeof useComposerDraftModelState>,
) {
  const {
    providerStatuses,
    settings,
    activeProjectId,
    threadModelSelection,
    projectModelSelection,
    promptInjectionState,
    candidateInstanceIds,
    lockedProvider,
    lockedInstanceId,
    threadStarted,
  } = input;
  const providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry> = providerInstanceEntriesFor(
    providerStatuses,
    settings,
    activeProjectId,
  );
  const selection = resolveComposerProviderSelection({
    entries: providerInstanceEntries,
    candidateInstanceIds: [
      draftModelSelectionApplies(draftModelState, threadStarted)
        ? draftModelState.activeProvider
        : null,
      ...candidateInstanceIds,
    ],
    lockedProvider,
    lockedInstanceId,
  });
  const selectedInstanceId =
    selection.selectedProviderEntry?.instanceId ?? NO_PROVIDER_MODEL_SELECTION.instanceId;
  const selectedProvider: ProviderDriverKind =
    selection.selectedProviderEntry?.driverKind ?? selection.requestedDriverKind;
  const modelState = deriveEffectiveComposerModelState({
    draft: draftModelState,
    threadStarted,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    requestedInstanceId: selection.requestedInstanceId,
    threadModelSelection,
    projectModelSelection,
    settings,
  });
  const selectedProviderModels = selection.selectedProviderEntry?.models ?? NO_PROVIDER_MODELS;
  const composerProviderState = getComposerProviderState({
    provider: selectedProvider,
    model: modelState.selectedModel,
    models: selectedProviderModels,
    promptInjectionState,
    modelOptions: modelState.modelOptions?.[selectedInstanceId],
  });
  return {
    providerInstanceEntries,
    ...selection,
    selectedInstanceId,
    selectedProvider,
    selectedProviderModels,
    composerModelOptions: modelState.modelOptions,
    selectedModel: modelState.selectedModel,
    composerProviderState,
  };
}

/**
 * What the composer would send if the user picked `pick`: the picker's provider and model
 * fallbacks and option normalization can turn it into something else.
 */
export function resolveComposerSendForPick(
  input: ComposerProviderModelInput,
  pick: ModelSelection,
): ModelSelection | null {
  // The thread keeps its stored selection until the pick is saved, and a send in that window
  // gives a pick without options the stored ones.
  const resolved = resolveComposerProviderModel(input, {
    modelSelectionByProvider: { [pick.instanceId]: pick },
    activeProvider: pick.instanceId,
    modelSelectionExplicit: true,
  });
  if (!resolved.selectedProviderEntry) return null;
  return createModelSelection(
    resolved.selectedInstanceId,
    resolved.selectedModel,
    resolved.composerProviderState.modelOptionsForDispatch,
  );
}

/**
 * The provider instances the composer offers, which one is selected, and the model and options
 * the draft resolves to on it. The draft store is read first so every derivation follows the only
 * hook here; in the composer body they would straddle its later hooks and lose their cache.
 */
export function useComposerProviderModel(input: ComposerProviderModelInput) {
  const draftModelState = useComposerDraftModelState(input.threadRef);
  return resolveComposerProviderModel(input, draftModelState);
}
