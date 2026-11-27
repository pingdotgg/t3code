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
  type ProviderInstanceId,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  NO_PROVIDER_MODEL_SELECTION,
  providerInstanceEntriesFor,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type UnifiedSettings } from "@t3tools/contracts/settings";
import { getComposerPromptInjectionState, getComposerProviderState } from "./composerProviderState";
import { resolveComposerProviderSelection } from "../ChatView.logic";
import { composerOrchestrator, useOrchestrationNow } from "../../customOrchestration";
import { useMessages } from "gt-react";

const NO_PROVIDER_MODELS: ServerProvider["models"] = [];

/**
 * The provider instances the composer offers, which one is selected, and the model and options
 * the draft resolves to on it. The draft store is read first so every derivation follows the only
 * hook here; in the composer body they would straddle its later hooks and lose their cache.
 */
export function useComposerProviderModel(
  input: Omit<Parameters<typeof resolveComposerProviderSelection>[0], "entries"> & {
    readonly providerStatuses: ReadonlyArray<ServerProvider>;
    readonly settings: UnifiedSettings;
    readonly activeProjectId: ProjectId | null;
    readonly threadRef: ScopedThreadRef | DraftId;
    readonly threadModelSelection: ModelSelection | null | undefined;
    readonly projectModelSelection: ModelSelection | null | undefined;
    readonly promptInjectionState: ReturnType<typeof getComposerPromptInjectionState>;
    readonly threadStarted: boolean;
    readonly modelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  },
) {
  const {
    providerStatuses,
    settings,
    activeProjectId,
    threadRef,
    threadModelSelection,
    projectModelSelection,
    promptInjectionState,
    candidateInstanceIds,
    lockedProvider,
    lockedInstanceId,
    threadStarted,
    modelDisabledReason,
  } = input;
  const draftModelState = useComposerDraftModelState(threadRef);
  const now = useOrchestrationNow(settings.customOrchestration.orchestrator !== null);
  const resolveMessage = useMessages();
  const providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry> = providerInstanceEntriesFor(
    providerStatuses,
    settings,
    activeProjectId,
  );
  const draftProvider = draftModelSelectionApplies(draftModelState, threadStarted)
    ? draftModelState.activeProvider
    : null;
  const pickedSelection =
    (draftProvider ? draftModelState.modelSelectionByProvider[draftProvider] : undefined) ??
    threadModelSelection ??
    projectModelSelection;
  const customOrchestration = pickedSelection?.orchestration === "custom";
  const resolvedSelection = resolveComposerProviderSelection({
    entries: providerInstanceEntries,
    candidateInstanceIds: [draftProvider, ...candidateInstanceIds],
    lockedProvider,
    lockedInstanceId,
  });
  const orchestration = composerOrchestrator({
    settings,
    entries: providerInstanceEntries,
    projectId: activeProjectId,
    now,
    lockedProvider,
    lockedContinuationGroupKey: resolvedSelection.lockedContinuationGroupKey,
    modelDisabledReason,
    resolve: resolveMessage,
  });
  // A Custom Orchestration thread shows what its next send runs on, not the model last used.
  // An instance that is gone keeps the normal fallback, so the picker stays usable.
  const orchestrator = customOrchestration ? orchestration.selection : null;
  const orchestratorEntry = providerInstanceEntries.find(
    (entry) =>
      entry.instanceId === orchestrator?.instanceId &&
      (lockedProvider === null || entry.driverKind === lockedProvider),
  );
  const selection = orchestratorEntry
    ? {
        ...resolvedSelection,
        selectedProviderEntry: orchestratorEntry,
        unavailableProviderInstanceId: undefined,
      }
    : resolvedSelection;
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
  const selectedModel =
    orchestratorEntry && orchestrator ? orchestrator.model : modelState.selectedModel;
  const composerModelOptions =
    orchestratorEntry && orchestrator
      ? { ...modelState.modelOptions, [selectedInstanceId]: orchestrator.options ?? [] }
      : modelState.modelOptions;
  const composerProviderState = getComposerProviderState({
    provider: selectedProvider,
    model: selectedModel,
    models: selectedProviderModels,
    promptInjectionState,
    modelOptions: composerModelOptions?.[selectedInstanceId],
  });
  return {
    providerInstanceEntries,
    ...selection,
    selectedInstanceId,
    selectedProvider,
    selectedProviderModels,
    composerModelOptions,
    selectedModel,
    composerProviderState,
    customOrchestration,
    orchestration,
  };
}
