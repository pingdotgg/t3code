import type { ChatComposerProps } from "./chatComposerTypes";
import { useComposerDraftAttachments } from "./useComposerDraftAttachments";

import { useComposerProviderModel } from "./useComposerProviderModel";
import { getComposerPromptInjectionState, getComposerReasoningStep } from "./composerProviderState";
import { hasProviderSetup } from "./ProviderStatusBanner";
import {
  resolveCompatibleRuntimeMode,
  runtimeModeConfig,
  resolveRuntimeModeOptions,
} from "./runtimeModeConfig";
import { useManagedPolicy } from "../../state/managedPolicy";
import {
  EnvironmentRequestInvalidError,
  AuthOrchestrationOperateScope,
  clampManagedRuntimeMode,
  managedRuntimeModeDenial,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import {
  deriveComposerSendState,
  getAntigravitySendBlockReason,
  resolveComposerInteractionMode,
  threadShellHasStarted,
} from "../ChatView.logic";
import {
  providerSupportsManualCompaction,
  resolveContextWindowModelDisplayName,
  shouldReserveContextWindowMeter,
} from "./ContextWindowMeter.logic";
import {
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import { useProviderWorkspaceSnapshotRefresh } from "./useProviderWorkspaceSnapshotRefresh";
import type {
  KeybindingCommand,
  AssistantCitation,
  ChatAttachment as ContractChatAttachment,
  ChatFileAttachment,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  PreviewAnnotationPayload,
  ThreadContextRecord,
  EnvironmentContextRecord,
  ProviderInteractionMode,
  ResolvedKeybindingsConfig,
  RuntimeMode,
  RuntimeRequestId,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import {
  memo,
  use,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  type ComposerSubmissionIntent,
  collapseExpandedComposerCursor,
  composerRequiresModifier,
  composerStateAtPromptEnd,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  formatAssistantCitationForComposer,
  isPathSuggestionCurrent,
  extendReplacementRangeForTrailingSpace,
  replaceTextRange,
} from "../../composer-logic";
import { useComposerTriggerState } from "./useComposerTriggerState";
import { type ComposerPromptHistoryPosition } from "./composerPromptHistory";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useSoftwareKeyboardOpen } from "../../hooks/useSoftwareKeyboardOpen";
import { useComposerMultilinePrompt } from "./useComposerMultilinePrompt";
import {
  type ComposerCitationCommentRequest,
  type ComposerPromptEditorHandle,
  ComposerPromptEditorTiptap as ComposerPromptEditor,
} from "../ComposerPromptEditorTiptap";
import {
  type ComposerCommandItem,
  ComposerCommandMenu,
  composerSuggestionOptionId,
} from "./ComposerCommandMenu";
import { BackgroundThreadContext } from "./backgroundThread";
import { isPasteAsTextShortcut } from "@t3tools/client-runtime/text-paste";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import { DESKTOP_PASTE_AS_TEXT_EVENT } from "../../lib/desktopPasteAsText";


const NO_PROVIDER_SKILLS: ServerProvider["skills"] = [];

const NO_PROVIDER_SLASH_COMMANDS: ServerProvider["slashCommands"] = [];

export function useComposerProviderModelState(props: ChatComposerProps, params: {
  s1: ReturnType<typeof useComposerDraftAttachments>,
  }) {
  const { s1 } = params;
  const { providerStatuses, settings, activeProjectId, composerDraftTarget, activeThreadModelSelection, activeProjectDefaultModelSelection, activeThread, lockedProvider, multipleModelSelections, providerCatalogKnown, compactDisabledReason, runtimeMode, environmentId, sendDisabledReason: externalSendDisabledReason, gitCwd, interactionMode: requestedInteractionMode, draftId, activeThreadId, forceExpandedOnMobile, isRevertingCheckpoint = false } = props;
  const { prompt, composerDraft, activePendingProgress, attachmentBlockReason, isLiteralPendingAnswer, pendingUserInputs } = s1;
    const {
      providerInstanceEntries,
      selectedProviderEntry,
      lockedContinuationGroupKey,
      unavailableProviderInstanceId,
      selectedInstanceId,
      selectedProvider,
      selectedProviderModels,
      composerModelOptions,
      selectedModel,
      composerProviderState,
    } = useComposerProviderModel({
      providerStatuses,
      settings,
      activeProjectId,
      threadRef: composerDraftTarget,
      threadModelSelection: activeThreadModelSelection,
      projectModelSelection: activeProjectDefaultModelSelection,
      promptInjectionState: getComposerPromptInjectionState(prompt),
      candidateInstanceIds: [
        composerDraft.activeProvider ?? null,
        activeThread?.runtime?.providerInstanceId,
        activeThreadModelSelection?.instanceId,
        activeProjectDefaultModelSelection?.instanceId,
      ],
      lockedProvider,
      lockedInstanceId:
        activeThread?.runtime?.providerInstanceId ?? activeThreadModelSelection?.instanceId,
    });
    const noProviderAvailable =
      selectedProviderEntry === undefined && multipleModelSelections === null;
    const providerCatalogPending = noProviderAvailable && !providerCatalogKnown;
    const showProviderUnavailable = noProviderAvailable && !providerCatalogPending;
    const providerSetupInstanceId = noProviderAvailable
      ? (unavailableProviderInstanceId ??
        (lockedProvider === null
          ? providerInstanceEntries.find((entry) => hasProviderSetup(entry.snapshot))?.instanceId
          : undefined))
      : undefined;
    const resolvedCompactDisabledReason =
      compactDisabledReason ?? (noProviderAvailable ? "Compacting is unavailable right now" : null);
    const { modes: compatibleRuntimeModes, mode: compatibleRuntimeMode } =
      resolveCompatibleRuntimeMode(
        runtimeMode,
        selectedProviderEntry?.snapshot.supportedRuntimeModes,
      );
    // Modes above an administrator's ceiling stay listed, disabled with the reason.
    const managedPolicy = useManagedPolicy(environmentId);
    const compatibleRuntimeModeOptions = resolveRuntimeModeOptions(
      compatibleRuntimeModes,
      managedPolicy,
    );
    // A thread or draft already above the ceiling would be refused; offer the broadest mode left.
    const runtimeModeCeilingDenial = managedRuntimeModeDenial(managedPolicy, compatibleRuntimeMode);
    const runtimeModeCeilingFallback =
      runtimeModeCeilingDenial === undefined
        ? undefined
        : clampManagedRuntimeMode(managedPolicy, compatibleRuntimeMode, compatibleRuntimeModes);

    const providerSendBlockReason = getAntigravitySendBlockReason(
      selectedProviderEntry?.snapshot,
      selectedModel,
    );
    const sendDisabledReason =
      externalSendDisabledReason ??
      (multipleModelSelections?.length === 0 ? "Select at least one model." : null) ??
      (activePendingProgress
        ? attachmentBlockReason
        : (attachmentBlockReason ??
          runtimeModeCeilingDenial ??
          (multipleModelSelections === null ? providerSendBlockReason : null)));
    const isSendDisabled = sendDisabledReason !== null;
    const selectedProviderStatus = selectedProviderEntry?.snapshot ?? null;
    const compactCommandAvailable = providerSupportsManualCompaction(selectedProviderEntry);
    const selectedProviderSkills = selectedProviderStatus
      ? resolveProviderSkillsForCwd(selectedProviderStatus, gitCwd)
      : NO_PROVIDER_SKILLS;
    const selectedProviderSlashCommands = selectedProviderStatus
      ? resolveProviderSlashCommandsForCwd(selectedProviderStatus, gitCwd)
      : NO_PROVIDER_SLASH_COMMANDS;
    const { refresh: refreshWorkspaceSnapshotOnTyping, scanning: workspaceSkillsScanning } =
      useProviderWorkspaceSnapshotRefresh({
        environmentId,
        gitCwd,
        instanceId: selectedProviderEntry?.instanceId,
      });

    const selectedPromptEffort = composerProviderState.promptEffort;
    const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
    const { enabled: planModeUiEnabled, interactionMode } = resolveComposerInteractionMode({
      planModeEnabled: settings.planModeEnabled,
      provider: selectedProviderStatus,
      interactionMode: requestedInteractionMode,
    });
    const selectedModelSelection: ModelSelection = createModelSelection(
      selectedInstanceId,
      selectedModel,
      selectedModelOptionsForDispatch,
    );
    const selectedModelForPicker = selectedModel;
    const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of providerInstanceEntries) {
      modelOptionsByInstance.set(
        entry.instanceId,
        getAppModelOptionsForInstance(
          settings,
          entry,
          entry.instanceId === selectedInstanceId ? selectedModelForPicker : null,
        ),
      );
    }

    const selectedModelForPickerWithCustomFallback = (() => {
      const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? [];
      return currentOptions.some((option) => option.slug === selectedModelForPicker)
        ? selectedModelForPicker
        : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
    })();

    const activeThreadModelDisplayName = resolveContextWindowModelDisplayName(
      activeThreadModelSelection,
      modelOptionsByInstance,
    );
    const reserveContextWindowMeter = shouldReserveContextWindowMeter({
      meterEnabled: settings.contextWindowMeterEnabled,
      detailLoading: props.threadSyncPhase === "loading",
      threadStarted: threadShellHasStarted(props.activeThreadShell),
      providerReportsContextWindow: selectedProviderStatus
        ? selectedProviderStatus.reportsContextWindow === true
        : null,
    });

    const [composerCursor, setComposerCursor] = useState(() => {
      const value = isLiteralPendingAnswer ? (activePendingProgress?.customAnswer ?? prompt) : prompt;
      return collapseExpandedComposerCursor(value, value.length, isLiteralPendingAnswer);
    });
    const {
      trigger: composerTrigger,
      setTrigger: setComposerTrigger,
      resolveTrigger: resolveComposerTrigger,
      dismissTrigger: dismissComposerTrigger,
      resetTrigger: resetComposerTrigger,
    } = useComposerTriggerState(() =>
      isLiteralPendingAnswer ? null : detectComposerTrigger(prompt, prompt.length),
    );
    const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
    const composerSuggestionId = useId();
    const composerSuggestionListId = `${composerSuggestionId}-${encodeURIComponent(draftId ?? activeThreadId ?? "new")}-suggestions`;
    const promptHistoryPositionRef = useRef<{
      targetKey: string;
      position: ComposerPromptHistoryPosition;
    } | null>(null);
    const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
      null,
    );
    const [isDragOverComposer, setIsDragOverComposer] = useState(false);
    const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
    const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
    const isMobileViewport = useMediaQuery("max-sm");
    const isSoftwareKeyboardOpen = useSoftwareKeyboardOpen();
    const [isComposerFocused, setIsComposerFocused] = useState(false);
    const [composerSubmissionError, setComposerSubmissionError] = useState<string | null>(null);
    const [providerInputSubmissionError, setProviderInputSubmissionError] = useState<string | null>(
      null,
    );
    const [composerMenuAnchor, setComposerMenuAnchor] = useState<HTMLDivElement | null>(null);
    const [hasWrappedPrompt, observeWrappedPrompt] = useComposerMultilinePrompt();
    const hasMultilinePrompt = prompt.includes("\n") || hasWrappedPrompt;
    // A pending question stays expanded: its card moves into the banner dock,
    // so collapsing would leave the surface empty and squashed beneath it.
    const isComposerCollapsedMobile =
      isMobileViewport &&
      !forceExpandedOnMobile &&
      !isComposerFocused &&
      !hasMultilinePrompt &&
      pendingUserInputs.length === 0;

    const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
    const pasteAsTextShortcutUntilRef = useRef(0);
    const composerFormRef = useRef<HTMLFormElement>(null);
    const composerSurfaceRef = useRef<HTMLDivElement>(null);
    const providerInputRejectedRef = useRef(false);
    const composerSelectLockRef = useRef(false);
    const composerMenuOpenRef = useRef(false);
    const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
    const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
    const composerBlurFrameRef = useRef<number | null>(null);
    const mobileComposerExpandFrameRef = useRef<number | null>(null);
    const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null);
    const mobileComposerExpandInFlightRef = useRef(false);
    const pendingThreadImportsRef = useRef<Map<string, number>>(new Map());
    const isRevertingCheckpointRef = useRef(isRevertingCheckpoint);
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed checkpoint revert flag to a ref read by async handlers
    useLayoutEffect(() => {
      isRevertingCheckpointRef.current = isRevertingCheckpoint;
    });

    const backgroundThread = use(BackgroundThreadContext);
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to keydown, window blur and the desktop paste-as-text event to arm plain-text paste
    useEffect(() => {
      // A background composer listens on its own form, so it never hears the main composer's keys.
      const target: EventTarget | null = backgroundThread ? composerFormRef.current : window;
      if (target === null) return;
      const armPasteAsTextShortcut = () => {
        // Electron's menu action can precede paste; browsers deliver keydown first.
        pasteAsTextShortcutUntilRef.current = Date.now() + 1_000;
      };
      const onKeyDown = (event: Event) => {
        if (
          event instanceof KeyboardEvent &&
          event.target instanceof Node &&
          composerFormRef.current?.contains(event.target) &&
          isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))
        ) {
          armPasteAsTextShortcut();
        }
      };
      const onBlur = () => {
        pasteAsTextShortcutUntilRef.current = 0;
      };
      const onDesktopPasteAsText = () => {
        const activeElement = document.activeElement;
        const blocksPasteToFocus =
          activeElement instanceof Element &&
          activeElement.closest(
            'input, textarea, select, button, a[href], summary, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], [role="button"], [role="menuitem"], [role="option"]',
          ) !== null;
        // A background composer takes no paste-to-focus, so it arms only for its own focus.
        if (
          (activeElement instanceof Node && composerFormRef.current?.contains(activeElement)) ||
          (!blocksPasteToFocus && !backgroundThread)
        ) {
          armPasteAsTextShortcut();
        }
      };
      target.addEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, onDesktopPasteAsText);
      target.addEventListener("keydown", onKeyDown, true);
      // An arm lasts a second, so a background composer can skip the window blur reset.
      if (!backgroundThread) window.addEventListener("blur", onBlur);
      return () => {
        target.removeEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, onDesktopPasteAsText);
        target.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("blur", onBlur);
      };
    }, [backgroundThread]);

  return { providerInstanceEntries, lockedContinuationGroupKey, selectedInstanceId, selectedProvider, selectedProviderModels, composerModelOptions, selectedModel, composerProviderState, noProviderAvailable, providerCatalogPending, showProviderUnavailable, providerSetupInstanceId, resolvedCompactDisabledReason, compatibleRuntimeMode, compatibleRuntimeModeOptions, runtimeModeCeilingDenial, runtimeModeCeilingFallback, providerSendBlockReason, sendDisabledReason, isSendDisabled, compactCommandAvailable, selectedProviderSkills, selectedProviderSlashCommands, refreshWorkspaceSnapshotOnTyping, workspaceSkillsScanning, selectedPromptEffort, planModeUiEnabled, interactionMode, selectedModelSelection, modelOptionsByInstance, selectedModelForPickerWithCustomFallback, activeThreadModelDisplayName, reserveContextWindowMeter, composerCursor, setComposerCursor, composerTrigger, setComposerTrigger, resolveComposerTrigger, dismissComposerTrigger, resetComposerTrigger, composerHighlightedItemId, setComposerHighlightedItemId, composerSuggestionListId, promptHistoryPositionRef, composerHighlightedSearchKey, setComposerHighlightedSearchKey, isDragOverComposer, setIsDragOverComposer, isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact, isComposerModelPickerOpen, setIsComposerModelPickerOpen, isMobileViewport, isSoftwareKeyboardOpen, setIsComposerFocused, composerSubmissionError, setComposerSubmissionError, providerInputSubmissionError, setProviderInputSubmissionError, composerMenuAnchor, setComposerMenuAnchor, observeWrappedPrompt, isComposerCollapsedMobile, composerEditorRef, pasteAsTextShortcutUntilRef, composerFormRef, composerSurfaceRef, providerInputRejectedRef, composerSelectLockRef, composerMenuOpenRef, composerMenuItemsRef, activeComposerMenuItemRef, composerBlurFrameRef, mobileComposerExpandFrameRef, mobileComposerExpandReleaseFrameRef, mobileComposerExpandInFlightRef, pendingThreadImportsRef, isRevertingCheckpointRef };
}
