import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { UnifiedSettings } from "@t3tools/contracts";
import type { Dispatch } from "react";
import type { ComposerThreadTarget, DraftSessionState } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useApplyThreadModelPick } from "./useApplyThreadModelPick";
import {
  type EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
  RuntimeMode,
} from "@t3tools/contracts";
import type { deriveThreadStructureRuntime } from "@t3tools/client-runtime/state/thread-execution";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type SetStateAction } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toastManager } from "../ui/toast";
import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import { resolveNewDraftStartFromOrigin } from "../../lib/chatThreadActions";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../../composerDraftStore";
import {
  getStartedThreadModelChangeBlockReason,
  deriveLockedProvider,
  makeModelDisabledReason,
} from "../ChatView.logic";
interface ComposerSelectionInput {
  readonly environmentId: EnvironmentId;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly draftThread: DraftSessionState | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeRuntime: ReturnType<typeof deriveThreadStructureRuntime>;
  readonly activeProjectSettings: {
    readonly settings: { readonly newWorktreesStartFromOrigin: boolean };
  };
  readonly settings: UnifiedSettings;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly lockedProvider: ReturnType<typeof deriveLockedProvider>;
  readonly supportsProviderSwitchingViaHandoff: boolean;
  readonly multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  readonly runtimeMode: RuntimeMode;
  readonly isLocalDraftThread: boolean;
  readonly canOverrideServerThreadEnvMode: boolean;
  readonly setPendingServerThreadEnvModeEntry: Dispatch<
    SetStateAction<{ readonly threadId: ThreadId; readonly mode: DraftThreadEnvMode } | null>
  >;
  readonly setPendingServerThreadStartFromOriginByThreadId: Dispatch<
    SetStateAction<Record<string, boolean>>
  >;
  readonly scheduleComposerFocus: () => void;
  readonly setThreadRuntimeMode: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly threadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
      readonly createdAt?: string;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  /** Providers without in-session mode switches restart the session, so a live run keeps the draft for the next send. */
  readonly runInProgress: boolean;
}

/**
 * The composer's choices for the next turn: provider and model, runtime mode,
 * and where a new thread runs (local or a new worktree, from the remote's tip or not).
 */
export function useComposerSelection(input: ComposerSelectionInput) {
  const {
    environmentId,
    composerDraftTarget,
    draftThread,
    activeThread,
    activeRuntime,
    activeProjectSettings,
    settings,
    providerStatuses,
    lockedProvider,
    supportsProviderSwitchingViaHandoff,
    multipleModelSelections,
    runtimeMode,
    isLocalDraftThread,
    canOverrideServerThreadEnvMode,
    setPendingServerThreadEnvModeEntry,
    setPendingServerThreadStartFromOriginByThreadId,
    scheduleComposerFocus,
    setThreadRuntimeMode,
    runInProgress,
  } = input;
  const navigate = useNavigate();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const applyThreadModelPick = useApplyThreadModelPick();

  const handleRuntimeModeChange = (mode: RuntimeMode) => {
    if (mode === runtimeMode) return;
    setComposerDraftRuntimeMode(composerDraftTarget, mode);
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
    } else if (activeThread && !runInProgress) {
      void setThreadRuntimeMode({
        environmentId: activeThread.environmentId,
        input: {
          threadId: activeThread.id,
          runtimeMode: mode,
          createdAt: new Date().toISOString(),
        },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const currentDraftRuntimeMode = useComposerDraftStore
            .getState()
            .getComposerDraft(composerDraftTarget)?.runtimeMode;
          if (currentDraftRuntimeMode === mode) {
            setComposerDraftRuntimeMode(composerDraftTarget, null);
          }
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to update permission mode",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      });
    }
    scheduleComposerFocus();
  };
  const handleRuntimeModeChangeStable = useStableCallback(handleRuntimeModeChange);

  const openProviderSetup = (instanceId: ProviderInstanceId) => {
    void navigate({
      to: "/settings/providers",
      search: { environmentId, instanceId },
    });
  };
  const openProviderSetupStable = useStableCallback(openProviderSetup);

  // Keyed on the fields it reads: the thread and runtime objects change with
  // every streamed event, and a new function re-renders the whole model picker.
  const hasStartedSession = activeRuntime !== null;
  const runtimeProviderInstanceId = activeRuntime?.providerInstanceId ?? null;
  const currentModelSelection = activeThread?.modelSelection ?? null;
  const getModelDisabledReason = makeModelDisabledReason(
    currentModelSelection
      ? {
          hasStartedSession,
          supportsProviderSwitchingViaHandoff,
          currentModelSelection,
          currentProviderInstanceId: runtimeProviderInstanceId,
        }
      : null,
  );

  const onProviderModelSelect = (
    instanceId: ProviderInstanceId,
    model: string,
    options?: { focusComposer?: boolean },
  ) => {
    if (!activeThread) return;
    const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
    const resolvedDriverKind = entry?.driver ?? null;
    if (
      !supportsProviderSwitchingViaHandoff &&
      lockedProvider !== null &&
      resolvedDriverKind !== null &&
      resolvedDriverKind !== lockedProvider
    ) {
      if (options?.focusComposer !== false) scheduleComposerFocus();
      return;
    }
    if (
      !supportsProviderSwitchingViaHandoff &&
      lockedProvider !== null &&
      activeRuntime?.providerInstanceId
    ) {
      const currentEntry = providerStatuses.find(
        (snapshot) => snapshot.instanceId === activeRuntime.providerInstanceId,
      );
      if (
        currentEntry?.continuation?.groupKey &&
        entry?.continuation?.groupKey &&
        currentEntry.continuation.groupKey !== entry.continuation.groupKey
      ) {
        if (options?.focusComposer !== false) scheduleComposerFocus();
        return;
      }
    }
    const resolvedModel = resolveAppModelSelectionForInstance(
      instanceId,
      settings,
      providerStatuses,
      model,
    );
    if (!resolvedModel) {
      if (options?.focusComposer !== false) scheduleComposerFocus();
      return;
    }
    const rememberedOptions =
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[instanceId]?.[resolvedModel];
    const nextModelSelection: ModelSelection =
      rememberedOptions !== undefined && rememberedOptions.length > 0
        ? { instanceId, model: resolvedModel, options: [...rememberedOptions] }
        : { instanceId, model: resolvedModel };
    const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
      hasStartedSession: activeRuntime !== null,
      supportsProviderSwitchingViaHandoff,
      currentModelSelection: activeThread.modelSelection,
      currentProviderInstanceId: activeRuntime?.providerInstanceId ?? null,
      nextModelSelection,
    });
    if (modelChangeBlockReason) {
      toastManager.add({
        type: "warning",
        title: modelChangeBlockReason.title,
        description: modelChangeBlockReason.description,
      });
      if (options?.focusComposer !== false) scheduleComposerFocus();
      return;
    }
    const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    setComposerDraftModelSelection(threadRef, nextModelSelection, {
      explicit: true,
      replaceOptions: true,
    });
    setStickyComposerModelSelection(nextModelSelection);
    if (!isLocalDraftThread) applyThreadModelPick(threadRef);
    if (options?.focusComposer !== false) scheduleComposerFocus();
  };
  const onProviderModelSelectStable = useStableCallback(onProviderModelSelect);
  const onEnvModeChange = (mode: DraftThreadEnvMode) => {
    if (multipleModelSelections !== null) return;
    if (canOverrideServerThreadEnvMode) {
      if (activeThread) setPendingServerThreadEnvModeEntry({ threadId: activeThread.id, mode });
      scheduleComposerFocus();
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        envMode: mode,
        startFromOrigin: resolveNewDraftStartFromOrigin({
          envMode: mode,
          newWorktreesStartFromOrigin: activeProjectSettings.settings.newWorktreesStartFromOrigin,
        }),
        ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
      });
    }
    scheduleComposerFocus();
  };
  const onEnvModeChangeStable = useStableCallback(onEnvModeChange);

  // Reads only the id: the shell changes on every streamed event, and a new handler
  // re-renders the branch toolbar and thread details panel with it.
  const activeThreadId = activeThread?.id;
  const onStartFromOriginChange = (nextStartFromOrigin: boolean) => {
    if (canOverrideServerThreadEnvMode && activeThreadId !== undefined) {
      setPendingServerThreadStartFromOriginByThreadId((current) =>
        current[activeThreadId] === nextStartFromOrigin
          ? current
          : { ...current, [activeThreadId]: nextStartFromOrigin },
      );
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        startFromOrigin: nextStartFromOrigin,
      });
    }
  };
  return {
    getModelDisabledReason,
    handleRuntimeModeChangeStable,
    onEnvModeChangeStable,
    onProviderModelSelectStable,
    onStartFromOriginChange,
    openProviderSetupStable,
  };
}
