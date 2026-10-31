import { useComposerTypingGuard } from "./useComposerTypingGuard";
import { insertAttachmentReferencesForDraft } from "./composerAttachmentReferences";
import { DESKTOP_PASTE_AS_TEXT_EVENT } from "../../lib/desktopPasteAsText";
import { BackgroundThreadContext } from "./backgroundThread";
import {
  resolveCompatibleRuntimeMode,
  runtimeModeConfig,
  runtimeModeOptions as runtimeModes,
} from "./runtimeModeConfig";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useRightPanelStore } from "~/rightPanelStore";
import { importPastedComposerText, readPastedComposerContext } from "../composerInlineTokenPaste";
import {
  questionAttachmentDraftId,
  trackOpenQuestionAttachmentDraft,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
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
import {
  EnvironmentRequestInvalidError,
  AuthOrchestrationOperateScope,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { isPasteAsTextShortcut } from "@t3tools/client-runtime/text-paste";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { folderDropTarget, resolveDroppedFolderPath } from "./folderDrop";
import { splitTransferredFiles } from "./workspaceFileDrop";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import { USAGE_LIMITS_COMMAND } from "@t3tools/shared/usageLimits";
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
import { flushSync } from "react-dom";
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
import { DEFAULT_COMPOSER_PLACEHOLDER } from "../../composerPlaceholder";
import {
  deriveComposerSendState,
  getAntigravitySendBlockReason,
  resolveComposerInteractionMode,
  threadShellHasStarted,
} from "../ChatView.logic";
import {
  dataTransferHasComposerMention,
  makeComposerMentionDragHandlers,
} from "./composerMentionDrag";
import { serializeComposerImages } from "./composerImagePersistence";
import {
  isInsideCollapsedComposerControls,
  isInsideRestingComposerControlScope,
  markOpenToEffort,
  markOpenToPermissions,
} from "./composerEventScope";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  composerFileNeedsReattach,
  composerDraftHasUserContent,
  composerTargetKey,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerStashMenu } from "./ComposerStashMenu";
import { useComposerTriggerState } from "./useComposerTriggerState";
import { useComposerMenuItems } from "./useComposerMenuItems";
import { useComposerMultilinePrompt } from "./useComposerMultilinePrompt";
import {
  reconcileAttachmentContextReferences,
  useRetainedContextPayloads,
} from "./composerContextUndo";
import type { ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerSurface } from "./ComposerSurface";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import {
  attachmentsToReleaseOnUploadCapabilityLoss,
  composerOtherFilesForPresentation,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  isPreviewableComposerVideo,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";
import {
  releaseAttachmentUpload,
  releaseDraftAttachment,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { attachmentUploadBlockReason } from "../../lib/attachmentUploadState";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../../lib/terminalContext";
import {
  threadContextRecord,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import {
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "../composerFooterLayout";
import {
  type ComposerCitationCommentRequest,
  type ComposerPromptEditorHandle,
  ComposerPromptEditorTiptap as ComposerPromptEditor,
} from "../ComposerPromptEditorTiptap";
import {
  ComposerContextActionsContext,
  composerContextRecordsFromDraft,
} from "../composerContextPresentation";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import {
  collectInlineContextIds,
  type ComposerContextReference,
  ensureInlineContextReferences,
  formatInlineContextReference,
  insertInlineContextReference,
  inlineContextReferenceReplacement,
} from "~/lib/composerContextReferences";
import {
  attachmentContextRecord,
  uploadedAttachmentContextRecord,
  previewAnnotationContextId,
  previewAnnotationContextRecord,
  reviewCommentContextId,
  reviewCommentContextReference,
  reviewCommentContextRecord,
  terminalContextReference,
  terminalContextRecord,
  threadContextReference,
  environmentContextRecord,
  environmentContextReference,
} from "~/lib/composerContextRecords";
import { rememberCopiedComposerAttachments } from "~/lib/copiedComposerAttachments";
import { useThreadContextDrop, threadContextDropTargetProps } from "./threadContextDrag";
import { readThreadShell } from "~/state/entities";
import { useLinkedEnvironments } from "~/state/peerLinks";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import type { ComposerContextRecord, ThreadPullRequestLink } from "@t3tools/contracts";
import { threadContextAttachment } from "~/lib/threadContextAttachment";
import {
  type ComposerCommandItem,
  ComposerCommandMenu,
  composerSuggestionOptionId,
} from "./ComposerCommandMenu";
import {
  ComposerAttachButton,
  ComposerAttachmentFileList,
  ComposerAttachmentMediaRow,
  ComposerFilePreviewDialog,
  ComposerQueuedAttachmentRow,
  ComposerRestingImagePreviews,
} from "./ComposerAttachmentStrip";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerFooterPrimaryActions } from "./ComposerFooterControls";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { buildPullRequestReferenceContext } from "../pullRequest/pullRequestDetail.logic";
import { getComposerPromptInjectionState, getComposerReasoningStep } from "./composerProviderState";
import { readPromptUltrathink } from "./TraitsPicker";
import {
  providerSupportsManualCompaction,
  resolveContextWindowModelDisplayName,
  shouldReserveContextWindowMeter,
} from "./ContextWindowMeter.logic";
import {
  buildAttachmentVideoPreview,
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import {
  getComposerPromptLengthValidationMessage,
  getComposerSubmissionValidationMessage,
  submitComposerDraft,
} from "./composerSubmission";
import { ComposerPromptLengthValidation } from "./ComposerPromptLengthValidation";
import { pendingDraftWork } from "./pendingDraftWork";
import { importComposerThreadAttachment } from "./composerThreadImport";
import { observeResize } from "~/lib/observeResize";

const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);
import { toastManager } from "../ui/toast";
import { PlayIcon } from "lucide-react";
import { proposedPlanTitle } from "@t3tools/shared/proposedPlanText";
import { hasProviderSetup } from "./ProviderStatusBanner";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  isVideoAttachment,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type ThreadShell,
} from "../../types";
import { type ComposerPromptHistoryPosition } from "./composerPromptHistory";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import type {
  LatestProposedPlanState,
  PendingApproval,
  PendingUserInput,
} from "../../session-logic";
import {
  resolveComposerDispatchMode,
  type ComposerDispatchMode,
} from "@t3tools/client-runtime/state/composer-dispatch";
import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import {
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useSoftwareKeyboardOpen } from "../../hooks/useSoftwareKeyboardOpen";
import { useStableCallback } from "../../hooks/useStableCallback";
import { usePanelAnimationSettings } from "../../panelAnimations";
import { readEnvironmentScope } from "../../state/session";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { useComposerRestingTransition } from "./useComposerRestingTransition";
import { ComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";
import { useRestingComposerControlsLayout } from "./useRestingComposerControlsLayout";
import { useProviderWorkspaceSnapshotRefresh } from "./useProviderWorkspaceSnapshotRefresh";
import { useComposerProviderModel } from "./useComposerProviderModel";
import { useComposerImageGroups } from "./useComposerImageGroups";
import { useComposerStash } from "./useComposerStash";
import { useComposerContextImport } from "./useComposerContextImport";
import { useComposerAttachmentIntake } from "./useComposerAttachmentIntake";
import {
  countPreparingComposerImages,
  usePreparingComposerImages,
} from "./preparingComposerImages";
import { ComposerControlsBar } from "./ComposerControlsBar";
import { composerCommandKeyHandler } from "./composerCommandKey";

function consumePasteAsTextShortcut(deadline: { current: number }): boolean {
  const armed = Date.now() <= deadline.current;
  deadline.current = 0;
  return armed;
}

const runtimeModeOptions = runtimeModes.map((mode) => ({ mode, ...runtimeModeConfig[mode] }));

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  addDroppedFiles: (files: File[]) => void;
  addDroppedFolders: (folders: File[]) => void;
  hasPendingAttachments: () => boolean;
  insertTextAtEnd: (
    text: string,
    options?: { ensureLeadingBoundary?: boolean; clipboardData?: DataTransfer },
  ) => boolean;
  pasteTextAtEnd: (text: string, options?: { bypassAutoAttachment?: boolean }) => boolean;
  citeAssistantText: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  openModelPicker: () => void;
  stepReasoningEffort: (direction: 1 | -1) => void;
  toggleModelPicker: () => void;
  openControl: (command: KeybindingCommand) => void;
  isModelPickerOpen: () => boolean;
  isCaretAtStart: () => boolean;
  compactContext: () => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  addTerminalContext: (selection: TerminalContextSelection) => void;
  getSendContext: () => {
    answeringPendingUserInput: boolean;
    prompt: string;
    images: ComposerImageAttachment[];
    files: ComposerFileAttachment[];
    terminalContexts: TerminalContextDraft[];
    previewAnnotations: PreviewAnnotationPayload[];
    reviewComments: ReviewCommentContext[];
    threadContexts: ThreadContextRecord[];
    environmentContexts: EnvironmentContextRecord[];
    selectedPromptEffort: string | null;
    selectedModelSelection: ModelSelection;
    multipleModelSelections: ReadonlyArray<ModelSelection> | null;
    providerAvailable: boolean;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
    interactionMode: ProviderInteractionMode;
    interactionModeEnabled: boolean;
    shownPendingApprovalIds: ReadonlyArray<RuntimeRequestId>;
  };
  validateProviderInput: (providerInput: string) => boolean;
  setMultipleModelSelections: (selections: ReadonlyArray<ModelSelection>) => void;
}

export interface ChatComposerProps {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  canOperateThread: boolean;
  attachmentUploadsCapabilityKnown: boolean;
  supportsAttachmentUploads: boolean;
  supportsQuestionAttachments: boolean;
  maxFileAttachmentBytes: number | null;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;
  multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  supportsMultipleModels: boolean;
  onMultipleModelSelectionsChange: React.Dispatch<
    React.SetStateAction<ReadonlyArray<ModelSelection> | null>
  >;

  activeThreadId: ThreadId | null;
  activeThread: Thread | undefined;
  activeThreadShell: ThreadShell | null;
  promptHistoryMessages: ReadonlyArray<ChatMessage>;
  forceExpandedOnMobile: boolean;
  projectSelectionRequired: boolean;

  phase: SessionPhase;
  canInterrupt: boolean;
  isSendBusy: boolean;
  canResume: boolean;
  isRevertingCheckpoint?: boolean;
  sendDisabledReason: string | null;
  isPreparingWorktree: boolean;
  isCompacting: boolean;
  bannerItems: readonly ComposerBannerStackItem[];
  resumeCompactionTokens: number | null;
  keepFullHistory: boolean;
  onToggleKeepFullHistory: () => void;
  onUsageLimitsCommand?: (() => void) | undefined;
  sideChatAvailable?: boolean;
  sideChatDisabledReason?: string | null;
  environmentUnavailable: {
    readonly label: string;
    readonly connection: EnvironmentConnectionPresentation;
  } | null;

  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  onHeldRequestIdsChange: (requestIds: ReadonlySet<string>) => void;
  pendingUserInputs: PendingUserInput[];
  activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
    activeQuestion: {
      id: string;
      initialAnswer?: string | undefined;
      multiSelect?: boolean | undefined;
      allowCustomAnswer?: boolean | undefined;
    } | null;
  } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activePendingIsResponding: boolean;
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  respondingRequestIds: RuntimeRequestId[];

  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: LatestProposedPlanState | null;
  threadSyncPhase: ThreadSyncPhase | null;

  runtimeMode: RuntimeMode;
  defaultRuntimeMode?: RuntimeMode;
  interactionMode: ProviderInteractionMode;

  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  providerCatalogKnown: boolean;
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  activeThreadModelSelection: ModelSelection | null | undefined;
  reportedModelSelection?: ModelSelection | null;
  activeProjectId: ProjectId | null;

  activeContextWindow: ContextWindowSnapshot | null;
  compactThreadUnavailable: boolean;
  compactDisabled: boolean;
  compactDisabledReason: string | null;

  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  gitCwd: string | null;
  pullRequestProjectId: ProjectId | null;
  pullRequestRepository: string | null;
  threadPullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined;
  onComposerOverlayHeightChange: (height: number) => void;
  /** The new-thread strip names the permissions, so the controls row hides its chip. */
  permissionsShownInStrip: boolean;

  promptRef: React.RefObject<string>;
  composerImagesRef: React.RefObject<ComposerImageAttachment[]>;
  composerFilesRef: React.RefObject<ComposerFileAttachment[]>;
  composerTerminalContextsRef: React.RefObject<TerminalContextDraft[]>;
  composerRef: React.RefObject<ChatComposerHandle | null>;
  onPageScrollKeyDown: (key: "PageUp" | "PageDown") => void;
  onPageScrollKeyUp: (key: string) => void;
  onPageScrollRelease: () => void;

  editingQueuedAttachments: ReadonlyArray<{
    readonly attachment: ContractChatAttachment;
    readonly url: string | null;
  }> | null;
  onRemoveEditingQueuedAttachment: (attachmentId: string) => void;

  onCompactContext: () => void;
  onSend: (
    e?: { preventDefault: () => void },
    dispatchMode?: ComposerDispatchMode,
    submissionIntent?: ComposerSubmissionIntent,
  ) => void;
  onResume: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  onSelectActivePendingUserInputOption: (questionId: string, optionValue: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onDismissActivePendingUserInput: (requestId: RuntimeRequestId) => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;

  onProviderModelSelect: (
    instanceId: ProviderInstanceId,
    model: string,
    options?: { focusComposer?: boolean },
  ) => void;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;

  focusComposer: () => void;
  scheduleComposerFocus: () => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onFileOpen: (attachment: ChatFileAttachment) => void;
}

const NO_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const NO_PROVIDER_SLASH_COMMANDS: ServerProvider["slashCommands"] = [];

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    composerDraftTarget,
    environmentId,
    canOperateThread,
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    supportsQuestionAttachments,
    maxFileAttachmentBytes,
    routeKind,
    routeThreadRef,
    draftId,
    multipleModelSelections,
    supportsMultipleModels,
    onMultipleModelSelectionsChange: setMultipleModelSelections,
    activeThreadId,
    activeThread,
    promptHistoryMessages,
    forceExpandedOnMobile,
    projectSelectionRequired,
    phase,
    canInterrupt,
    isSendBusy,
    canResume,
    isRevertingCheckpoint = false,
    sendDisabledReason: externalSendDisabledReason,
    isPreparingWorktree,
    isCompacting,
    environmentUnavailable,
    activePendingApproval: incomingPendingApproval,
    pendingApprovals,
    onHeldRequestIdsChange,
    pendingUserInputs: incomingPendingUserInputs,
    activePendingProgress: incomingPendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding: incomingPendingIsResponding,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    runtimeMode,
    interactionMode: requestedInteractionMode,
    lockedProvider,
    providerStatuses,
    providerCatalogKnown,
    activeProjectDefaultModelSelection,
    activeThreadModelSelection,
    reportedModelSelection,
    activeProjectId,
    activeContextWindow,
    compactThreadUnavailable,
    compactDisabled,
    compactDisabledReason,
    resolvedTheme,
    settings,
    keybindings,
    terminalOpen,
    gitCwd,
    pullRequestProjectId,
    pullRequestRepository,
    threadPullRequests,
    onComposerOverlayHeightChange,
    promptRef,
    composerRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    onPageScrollKeyDown,
    onPageScrollKeyUp,
    onPageScrollRelease,
    onCompactContext,
    onSend,
    onResume,
    onInterrupt,
    onImplementPlanInNewThread,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onDismissActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect,
    onOpenProviderSetup,
    getModelDisabledReason,
    toggleInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    focusComposer,
    scheduleComposerFocus,
    setThreadError,
    onExpandImage,
    onFileOpen,
    editingQueuedAttachments,
    onRemoveEditingQueuedAttachment,
  } = props;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const composerDraftTargetKey = composerTargetKey(composerDraftTarget);
  const {
    heldRequestIds,
    onDraftChange: onTypingGuardDraftChange,
    onFocus: onTypingGuardFocus,
    onBlur: onTypingGuardBlur,
    onSend: onTypingGuardSend,
  } = useComposerTypingGuard(composerDraftTargetKey, [
    ...pendingApprovals.map((request) => request.requestId),
    ...incomingPendingUserInputs.map((request) => request.requestId),
  ]);
  // A layout effect so the timeline never paints a held approval as answerable.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes held requests to the timeline without lifting per-keystroke typing state
  useLayoutEffect(() => {
    onHeldRequestIdsChange(heldRequestIds);
  }, [heldRequestIds, onHeldRequestIdsChange]);
  const activePendingApproval =
    incomingPendingApproval && !heldRequestIds.has(incomingPendingApproval.requestId)
      ? incomingPendingApproval
      : null;
  const holdingUserInput = incomingPendingUserInputs[0]
    ? heldRequestIds.has(incomingPendingUserInputs[0].requestId)
    : false;
  const pendingUserInputs = holdingUserInput ? [] : incomingPendingUserInputs;
  const activePendingProgress = holdingUserInput ? null : incomingPendingProgress;
  const activePendingIsResponding = !holdingUserInput && incomingPendingIsResponding;
  const isLiteralPendingAnswer = activePendingProgress?.activeQuestion?.initialAnswer !== undefined;
  const isEditingQueuedMessage = editingQueuedAttachments !== null;
  const composerDraft = useComposerThreadDraft(composerDraftTarget);
  const composerDraftTargetKeyRef = useRef("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed draft target key to a ref read by async handlers
  useLayoutEffect(() => {
    composerDraftTargetKeyRef.current = composerDraftTargetKey;
  });
  const questionAttachmentTarget =
    pendingUserInputs[0] && activePendingProgress?.activeQuestion
      ? questionAttachmentDraftId(
          environmentId,
          activeThreadId!,
          pendingUserInputs[0].requestId,
          activePendingProgress.activeQuestion.id,
        )
      : null;
  const attachmentDraftTarget = questionAttachmentTarget ?? composerDraftTarget;
  const attachmentDraft = useComposerThreadDraft(attachmentDraftTarget);
  const questionTakesSnapShots =
    supportsQuestionAttachments &&
    activePendingProgress?.activeQuestion?.allowCustomAnswer !== false &&
    !activePendingIsResponding;
  const questionRequest = pendingUserInputs[0];
  // Publish eligibility before async captures can observe a question the UI has already closed.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the open question's attachment draft in the module tracker before async captures read it
  useLayoutEffect(() => {
    if (!questionAttachmentTarget || !questionRequest || !questionTakesSnapShots) return;
    return trackOpenQuestionAttachmentDraft(routeThreadRef, {
      draftId: questionAttachmentTarget,
      requestKeys: questionRequest.questions.map((question) =>
        questionAttachmentDraftId(
          environmentId,
          activeThreadId!,
          questionRequest.requestId,
          question.id,
        ),
      ),
    });
  }, [
    activeThreadId,
    environmentId,
    questionAttachmentTarget,
    questionRequest,
    questionTakesSnapShots,
    routeThreadRef,
  ]);
  const attachmentTargetKey = composerTargetKey(attachmentDraftTarget);
  // Reject async imports after a draft switch.
  const attachmentTargetKeyRef = useRef(attachmentTargetKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed attachment target key to a ref so async imports reject after a draft switch
  useLayoutEffect(() => {
    attachmentTargetKeyRef.current = attachmentTargetKey;
  });
  const questionPreparations = useQuestionAttachmentPreparation((state) => state.counts);
  const prompt = composerDraft.prompt;
  const composerImages = attachmentDraft.images;
  const composerFiles = attachmentDraft.files;
  const inlineFileIdSet = (() => {
    if (questionAttachmentTarget) return new Set<string>();
    const contextIds = new Set(collectInlineContextIds(prompt));
    return new Set(
      composerFiles
        .filter((file) => contextIds.has(toKindScopedComposerContextId("file", file.id)))
        .map((file) => file.id),
    );
  })();
  const composerVideos = composerFiles.filter((file) =>
    isPreviewableComposerVideo(file, environmentId),
  );
  const composerOtherFiles = composerOtherFilesForPresentation(
    composerFiles,
    environmentId,
    inlineFileIdSet,
  );
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerPreviewAnnotations = composerDraft.previewAnnotations;
  const composerReviewComments = composerDraft.reviewComments;
  const composerThreadContexts = attachmentDraft.threadContexts;
  const composerEnvironmentContexts = composerDraft.environmentContexts;
  const {
    pendingSnapShotAnimations,
    pendingSnapShotIds,
    uncommittedSnapShotIds,
    standaloneComposerImages,
  } = useComposerImageGroups(attachmentDraftTarget, composerImages, composerPreviewAnnotations);
  const preparingComposerImages = usePreparingComposerImages(attachmentTargetKey);
  const nonPersistedComposerImageIds = attachmentDraft.nonPersistedImageIds;
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const openPrLink = useOpenPrLink(routeThreadRef);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const previewFile = composerFiles.find((file) => file.id === previewFileId);
  const composerContextActions = {
    environmentId,
    cwd: gitCwd ?? undefined,
    expandImage: (imageId: string) => {
      const preview = buildExpandedImagePreview(composerImages, imageId);
      if (preview) onExpandImage(preview);
    },
    openFile: setPreviewFileId,
    openMention: (path: string) => useRightPanelStore.getState().openFile(routeThreadRef, path),
    expandVideo: (fileId: string) => {
      const file = composerFiles.find((candidate) => candidate.id === fileId);
      if (!file || !isVideoAttachment(file)) return;
      const localPreview = buildExpandedImagePreview([file], file.id);
      if (localPreview) {
        onExpandImage(localPreview);
        return;
      }
      if (file.uploadedAttachmentId === undefined || file.uploadEnvironmentId !== environmentId) {
        return;
      }
      const persistedPreview = buildAttachmentVideoPreview(environmentId, {
        type: "file",
        id: file.uploadedAttachmentId,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      });
      if (persistedPreview) onExpandImage(persistedPreview);
    },
    openPullRequest: (event: React.MouseEvent<HTMLElement>, url: string) => {
      openPrLink(event, url);
    },
  };
  const composerContextRecords = composerContextRecordsFromDraft({
    terminalContexts: composerTerminalContexts,
    reviewComments: composerReviewComments,
    previewAnnotations: composerPreviewAnnotations,
    threadContexts: composerThreadContexts,
    environmentContexts: composerEnvironmentContexts,
    images: composerImages,
    files: composerFiles,
    uploadsByImageId,
  });
  const needsReattachFileCount = composerFiles.filter(composerFileNeedsReattach).length;
  const fileStagingLimit = fileAttachmentStagingLimit({
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    maxFileAttachmentBytes,
  });
  const fileCapabilityBlockReason = fileAttachmentCapabilityBlockReason({
    files: composerFiles,
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    maxFileAttachmentBytes,
  });
  const attachmentBlockReason =
    (questionAttachmentTarget &&
    !supportsQuestionAttachments &&
    (composerImages.length > 0 || composerFiles.length > 0)
      ? "Update this server to send files with question answers"
      : null) ??
    fileCapabilityBlockReason ??
    (supportsAttachmentUploads
      ? needsReattachFileCount > 0
        ? needsReattachFileCount === 1
          ? "Attach the interrupted file again or remove it"
          : "Attach the interrupted files again or remove them"
        : attachmentUploadBlockReason({
            imageIds: [...composerImages, ...composerFiles].map((attachment) => attachment.id),
            uploadsByImageId,
            environmentId,
          })
      : null);
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeComposerDraftFile = useComposerDraftStore((store) => store.removeFile);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  );
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts or releases server attachment uploads as upload capability, limits and draft attachments change
  useEffect(() => {
    if (!attachmentUploadsCapabilityKnown) {
      return;
    }
    if (!supportsAttachmentUploads) {
      // Reconnect or version skew can hide upload support; retain hydrated uploads.
      for (const attachment of attachmentsToReleaseOnUploadCapabilityLoss([
        ...composerImages,
        ...composerFiles,
      ])) {
        releaseAttachmentUpload(attachment.id);
      }
      return;
    }
    if (!canOperateThread) return;
    const invalidFiles =
      maxFileAttachmentBytes === null
        ? composerFiles
        : composerFiles.filter((file) => file.sizeBytes > maxFileAttachmentBytes);
    for (const attachment of attachmentsToReleaseOnUploadCapabilityLoss(invalidFiles)) {
      releaseAttachmentUpload(attachment.id);
    }
    const uploadableFiles =
      maxFileAttachmentBytes === null
        ? []
        : composerFiles.filter((file) => file.sizeBytes <= maxFileAttachmentBytes);
    const uploadableAttachments = [...composerImages, ...uploadableFiles];
    for (const attachment of uploadableAttachments) {
      if (attachment.type === "file" && composerFileNeedsReattach(attachment)) {
        continue;
      }
      startAttachmentUpload({
        environmentId,
        image: attachment,
        draftTarget: attachmentDraftTarget,
      });
    }
  }, [
    attachmentUploadsCapabilityKnown,
    attachmentDraftTarget,
    canOperateThread,
    composerFiles,
    composerImages,
    environmentId,
    maxFileAttachmentBytes,
    supportsAttachmentUploads,
  ]);

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
  const compatibleRuntimeModeOptions = runtimeModeOptions.filter((option) =>
    compatibleRuntimeModes.includes(option.mode),
  );

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
  const refreshWorkspaceSnapshotOnTyping = useProviderWorkspaceSnapshotRefresh({
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

  const composerSendState = deriveComposerSendState({
    prompt,
    imageCount: composerImages.length + composerFiles.length,
    existingAttachmentCount: editingQueuedAttachments?.length ?? 0,
    terminalContexts: composerTerminalContexts,
    elementContextCount: composerPreviewAnnotations.length + composerReviewComments.length,
  });
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const compactSlashCommandAvailable =
    composerTrigger?.kind === "slash-command" &&
    prompt.slice(0, composerTrigger.rangeStart).trim() === "" &&
    !compactThreadUnavailable &&
    prompt.slice(composerTrigger.rangeEnd).trim() === "" &&
    composerImages.length + composerFiles.length === 0 &&
    composerDraft.persistedAttachments.length === 0 &&
    composerTerminalContexts.length === 0 &&
    composerPreviewAnnotations.length === 0 &&
    composerReviewComments.length === 0;
  const linkedEnvironments = useLinkedEnvironments(environmentId);
  const {
    items: composerMenuItems,
    isLoading: isComposerMenuLoading,
    emptyState: composerMenuEmptyState,
  } = useComposerMenuItems({
    composerTrigger,
    environmentId,
    linkedEnvironments,
    gitCwd,
    activeThreadId,
    pullRequestProjectId,
    pullRequestRepository,
    threadPullRequests,
    planModeUiEnabled,
    sideChatAvailable: props.sideChatAvailable === true,
    sideChatDisabledReason: props.sideChatDisabledReason ?? null,
    compactSlashCommandAvailable,
    selectedProvider,
    selectedProviderSkills,
    selectedProviderSlashCommands,
    showSkillsInSlashMenu: settings.showSkillsInSlashMenu,
    questionAttachmentTarget,
  });

  const composerMenuOpen = Boolean(composerTrigger);
  const composerMenuSearchKey = composerTrigger
    ? `${composerSuggestionListId}:${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
    : null;
  const activeComposerMenuItemId = resolveComposerMenuActiveItemId({
    items: composerMenuItems,
    highlightedItemId: composerHighlightedItemId,
    currentSearchKey: composerMenuSearchKey,
    highlightedSearchKey: composerHighlightedSearchKey,
  });
  const activeComposerMenuItem =
    composerMenuItems.find((item) => item.id === activeComposerMenuItemId) ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed composer menu state to refs read by editor key handlers
  useLayoutEffect(() => {
    composerMenuOpenRef.current = composerMenuOpen;
    composerMenuItemsRef.current = composerMenuItems;
    activeComposerMenuItemRef.current = activeComposerMenuItem;
  });

  const isComposerApprovalState = activePendingApproval !== null;
  // A send declines the approvals shown here to redirect the agent, so it steers the waiting
  // turn instead of queueing behind it. Approvals the typing guard holds stay unseen and pending.
  const followUpBehavior = pendingApprovals.some(
    (approval) => !heldRequestIds.has(approval.requestId),
  )
    ? "steer"
    : settings.followUpBehavior;
  const composerSuggestionsVisible = composerMenuOpen;
  const composerSuggestionListVisible = composerSuggestionsVisible && composerMenuItems.length > 0;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const isChoiceOnlyPendingQuestion =
    activePendingProgress?.activeQuestion?.allowCustomAnswer === false;
  const showComposerTopDrawer =
    pendingUserInputs.length > 0 ||
    (!isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan !== null);
  const showCollapsedMobilePromptRow = isComposerCollapsedMobile;
  const showComposerAttachAction =
    fileStagingLimit !== null &&
    (!activePendingProgress ||
      (supportsQuestionAttachments &&
        activePendingProgress.activeQuestion?.allowCustomAnswer !== false));
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;

  const editPromptFromTraits = (edit: (prompt: string) => string) => {
    const currentPrompt = getComposerDraft(composerDraftTarget)?.prompt ?? "";
    const nextPrompt = edit(currentPrompt);
    if (nextPrompt === currentPrompt) return;
    if (nextPrompt === promptRef.current) {
      scheduleComposerFocus();
      return;
    }
    promptRef.current = nextPrompt;
    setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
    scheduleComposerFocus();
  };
  const editPromptFromTraitsStable = useStableCallback(editPromptFromTraits);
  const promptUltrathink = readPromptUltrathink(prompt);

  const [inlineRestingControlsHost, setInlineRestingControlsHost] = useState<HTMLDivElement | null>(
    null,
  );
  const {
    controlsRef: restingComposerControlsRef,
    attachControls: attachRestingComposerControls,
    hiddenBlockCount: restingControlsHiddenBlockCount,
    iconOnlyBlockCount: restingControlsIconOnlyBlockCount,
    controlsVisible: restingControlsVisible,
  } = useRestingComposerControlsLayout(inlineRestingControlsHost);
  const {
    attachControls: attachExpandedComposerControls,
    hiddenBlockCount: expandedControlsHiddenBlockCount,
    iconOnlyBlockCount: expandedControlsIconOnlyBlockCount,
  } = useRestingComposerControlsLayout(null, true);
  const pendingPrimaryAction = activePendingProgress
    ? {
        questionIndex: activePendingProgress.questionIndex,
        isLastQuestion: activePendingProgress.isLastQuestion,
        canAdvance:
          activePendingProgress.canAdvance &&
          !attachmentBlockReason &&
          !(questionPreparations[attachmentTargetKey] ?? 0),
        isResponding: activePendingIsResponding,
        isComplete: Boolean(activePendingResolvedAnswers),
      }
    : null;
  const showResumeAction =
    canResume && !composerDraftHasUserContent(composerDraft) && !isEditingQueuedMessage;
  const collapsedComposerPrimaryActionDisabled =
    phase === "running" ||
    isSendBusy ||
    isSendDisabled ||
    noProviderAvailable ||
    projectSelectionRequired ||
    environmentUnavailable !== null ||
    (!composerSendState.hasSendableContent && !showResumeAction);
  const collapsedComposerPrimaryActionLabel = showResumeAction
    ? "Resume thread"
    : props.resumeCompactionTokens !== null && !props.keepFullHistory
      ? "Open composer to compact and send"
      : "Send message";
  const showMobilePendingAnswerActions =
    isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;

  const setPrompt = (nextPrompt: string) => {
    setComposerDraftPrompt(composerDraftTarget, nextPrompt);
  };

  const addComposerImage = (image: ComposerImageAttachment) =>
    addComposerDraftImages(attachmentDraftTarget, [image]);

  const addComposerImagesToDraft = (images: ComposerImageAttachment[]) =>
    addComposerDraftImages(attachmentDraftTarget, images);

  const addComposerFilesToDraft = (files: ComposerFileAttachment[]) =>
    addComposerDraftFiles(attachmentDraftTarget, files, {
      appendReference: questionAttachmentTarget === null,
    });

  const removeComposerImageFromDraft = (imageId: string) => {
    if (questionAttachmentTarget && activePendingIsResponding) return;
    releaseAttachmentUpload(imageId);
    removeComposerDraftImage(attachmentDraftTarget, imageId);
  };

  const removeComposerFileFromDraft = (fileId: string) => {
    if (questionAttachmentTarget && activePendingIsResponding) return;
    // Hydrated uploads use persisted attachment ids, not queue keys.
    const file = composerFilesRef.current.find((candidate) => candidate.id === fileId);
    if (file) {
      releaseDraftAttachment(file);
    } else {
      releaseAttachmentUpload(fileId);
    }
    removeComposerDraftFile(attachmentDraftTarget, fileId);
  };

  const addComposerDraftReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const addComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.addPreviewAnnotation,
  );
  const addComposerDraftThreadContexts = useComposerDraftStore((store) => store.addThreadContexts);
  const setComposerDraftThreadContexts = useComposerDraftStore((store) => store.setThreadContexts);
  const addComposerDraftEnvironmentContexts = useComposerDraftStore(
    (store) => store.addEnvironmentContexts,
  );
  const setComposerDraftEnvironmentContexts = useComposerDraftStore(
    (store) => store.setEnvironmentContexts,
  );
  const buildContextClipboardFragment = (contextIds: ReadonlyArray<string>): string | null => {
    const wanted = new Set(contextIds);
    const copiedFiles = new Map<string, File>();
    for (const annotation of composerPreviewAnnotations) {
      if (
        wanted.has(previewAnnotationContextId(annotation.id)) &&
        composerImages.some((image) => image.id === annotation.id)
      ) {
        wanted.add(toKindScopedComposerContextId("image", annotation.id));
      }
    }
    const records: ComposerContextRecord[] = [
      ...composerTerminalContexts
        .filter((c) => wanted.has(terminalContextReference(c).contextId))
        .map(terminalContextRecord),
      ...composerThreadContexts.filter((record) => wanted.has(record.contextId)),
      ...composerEnvironmentContexts.filter((record) => wanted.has(record.contextId)),
      ...composerReviewComments
        .filter((c) => wanted.has(reviewCommentContextId(c.id)))
        .map(reviewCommentContextRecord),
      ...composerPreviewAnnotations
        .filter((a) => wanted.has(previewAnnotationContextId(a.id)))
        .map((annotation) =>
          previewAnnotationContextRecord(annotation, {
            screenshotContextId: composerImages.some((image) => image.id === annotation.id)
              ? annotation.id
              : undefined,
          }),
        ),
      ...[...composerImages, ...composerFiles]
        .filter((attachment) =>
          wanted.has(toKindScopedComposerContextId(attachment.type, attachment.id)),
        )
        .flatMap((attachment) => {
          const record =
            uploadedAttachmentContextRecord(attachment, uploadsByImageId[attachment.id]) ??
            (attachment.file
              ? attachmentContextRecord({ attachment, attachmentId: attachment.id })
              : null);
          if (!record) return [];
          if (attachment.file) copiedFiles.set(record.attachmentId, attachment.file);
          return [record];
        }),
    ];
    if (records.length === 0) return null;
    const fragment = encodeComposerContextFragment({
      version: 1,
      source: { environmentId, ...(activeThread ? { threadId: activeThread.id } : {}) },
      records,
    });
    if (fragment) rememberCopiedComposerAttachments(environmentId, copiedFiles);
    return fragment;
  };
  const buildContextClipboardFragmentStable = useStableCallback(buildContextClipboardFragment);
  const {
    loadThreadTranscript,
    countReservedAttachments,
    countReservedAttachmentsStable,
    importContextRecords,
    importContextFragment,
    importContextFragmentStable,
  } = useComposerContextImport({
    environmentId,
    linkedEnvironments,
    activeThread,
    activeThreadId,
    composerDraftTarget,
    attachmentDraftTarget,
    attachmentTargetKey,
    attachmentTargetKeyRef,
    questionAttachmentTarget,
    pendingUserInputs,
    composerContextRecords,
    composerImages,
    composerFilesRef,
    promptRef,
    pendingThreadImportsRef,
    addComposerFilesToDraft,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the shared prompt ref in step with the committed draft prompt for imperative handlers
  useEffect(() => {
    if (isLiteralPendingAnswer) return;
    promptRef.current = prompt;
  }, [isLiteralPendingAnswer, prompt, promptRef]);
  const [cursorClampedFor, setCursorClampedFor] = useState({ prompt, isLiteralPendingAnswer });
  if (
    cursorClampedFor.prompt !== prompt ||
    cursorClampedFor.isLiteralPendingAnswer !== isLiteralPendingAnswer
  ) {
    setCursorClampedFor({ prompt, isLiteralPendingAnswer });
    if (!isLiteralPendingAnswer) {
      setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
    }
  }

  if (composerSubmissionError !== null) {
    const nextError = getComposerPromptLengthValidationMessage(prompt);
    if (nextError !== composerSubmissionError) {
      setComposerSubmissionError(nextError);
    }
  }

  const providerInputInputs = [
    composerPreviewAnnotations,
    composerReviewComments,
    composerTerminalContexts,
    prompt,
    selectedModel,
    selectedPromptEffort,
    selectedProvider,
  ] as const;
  const [providerInputValidatedFor, setProviderInputValidatedFor] = useState(providerInputInputs);
  if (providerInputInputs.some((value, index) => value !== providerInputValidatedFor[index])) {
    setProviderInputValidatedFor(providerInputInputs);
    setProviderInputSubmissionError(null);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the shared images ref in step with committed draft images for async handlers
  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages, composerImagesRef]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the shared files ref in step with committed draft files for async handlers
  useEffect(() => {
    composerFilesRef.current = composerFiles;
  }, [composerFiles, composerFilesRef]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the shared terminal contexts ref in step with committed draft contexts for async handlers
  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts, composerTerminalContextsRef]);

  const resolvedHighlightedItemId = composerMenuOpen ? activeComposerMenuItemId : null;
  const resolvedHighlightedSearchKey = composerMenuOpen ? composerMenuSearchKey : null;
  if (composerHighlightedItemId !== resolvedHighlightedItemId) {
    setComposerHighlightedItemId(resolvedHighlightedItemId);
  }
  if (composerHighlightedSearchKey !== resolvedHighlightedSearchKey) {
    setComposerHighlightedSearchKey(resolvedHighlightedSearchKey);
  }

  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the prompt ref and caret to the end when the pending question or its answer changes externally
  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      if (lastSyncedPendingInputRef.current !== null) {
        promptRef.current = prompt;
        const { cursor, trigger } = composerStateAtPromptEnd(prompt);
        setComposerCursor(cursor);
        resetComposerTrigger(trigger);
      }
      lastSyncedPendingInputRef.current = null;
      return;
    }

    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const { cursor, trigger } = composerStateAtPromptEnd(nextCustomAnswer, isLiteralPendingAnswer);
    setComposerCursor(cursor);
    resetComposerTrigger(trigger);
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingProgress?.activeQuestion?.id,
    isLiteralPendingAnswer,
    activePendingUserInput?.requestId,
    prompt,
    promptRef,
    resetComposerTrigger,
  ]);

  const composerSessionKey = `${draftId ?? ""}:${activeThreadId ?? ""}:${isLiteralPendingAnswer}`;
  const [shownComposerSessionKey, setShownComposerSessionKey] = useState(composerSessionKey);
  if (shownComposerSessionKey !== composerSessionKey) {
    setShownComposerSessionKey(composerSessionKey);
    setComposerHighlightedItemId(null);
    setComposerHighlightedSearchKey(null);
    setComposerSubmissionError(null);
    setProviderInputSubmissionError(null);
    const pendingAnswer = activePendingProgress?.customAnswer;
    const { cursor, trigger } = composerStateAtPromptEnd(
      typeof pendingAnswer === "string" ? pendingAnswer : prompt,
      isLiteralPendingAnswer,
    );
    setComposerCursor(cursor);
    resetComposerTrigger(trigger);
    setIsDragOverComposer(false);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes composer form resizes to switch the footer and primary actions between compact layouts
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measurePrimaryActionsCompact = () => {
      const composerFormWidth = composerForm.clientWidth;
      const options = { hasWideActions: composerFooterHasWideActions };
      return (
        shouldUseCompactComposerFooter(composerFormWidth, options) &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, options)
      );
    };

    setIsComposerPrimaryActionsCompact(measurePrimaryActionsCompact());
    return observeResize(composerForm, () => {
      setIsComposerPrimaryActionsCompact(measurePrimaryActionsCompact());
    });
  }, [composerFooterHasWideActions]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads draft images as data URLs and persists them to the draft store, dropping stale results on cleanup
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(attachmentDraftTarget);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        getComposerDraft(attachmentDraftTarget)?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const serialized = await serializeComposerImages(
          composerImages,
          currentPersistedAttachments,
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(attachmentDraftTarget, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds: Array<string> = [];
        for (const attachment of fallbackPersistedAttachments) {
          if (currentImageIds.has(attachment.id)) {
            fallbackPersistedIds.push(attachment.id);
          }
        }
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(attachmentDraftTarget, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    attachmentDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerImages,
    getComposerDraft,
    syncComposerDraftPersistedAttachments,
  ]);

  const retainedContextPayloads = useRetainedContextPayloads(composerDraftTargetKey);

  const onPromptChange = (
    nextPrompt: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    contextIds: string[],
  ) => {
    refreshWorkspaceSnapshotOnTyping();
    if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
      if (activePendingProgress.activeQuestion.allowCustomAnswer === false) return;
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
      onChangeActivePendingUserInputCustomAnswer(
        activePendingProgress.activeQuestion.id,
        nextPrompt,
        nextCursor,
        expandedCursor,
        cursorAdjacentToMention,
      );
      return;
    }
    onTypingGuardDraftChange();
    promptRef.current = nextPrompt;
    setPrompt(nextPrompt);
    if (promptHistoryPositionRef.current?.position.recalled !== nextPrompt) {
      promptHistoryPositionRef.current = null;
    }
    const referenced = new Set(contextIds);
    const retained = retainedContextPayloads;

    const liveTerminalIds = new Set<string>(
      composerTerminalContexts.map((context) => terminalContextReference(context).contextId),
    );
    const restoredTerminals = [...referenced].flatMap((contextId) => {
      if (liveTerminalIds.has(contextId)) return [];
      const context = retained.terminals.get(contextId);
      return context ? [context] : [];
    });
    const nextTerminals = [
      ...composerTerminalContexts.filter((context) =>
        referenced.has(terminalContextReference(context).contextId),
      ),
      ...restoredTerminals,
    ];
    for (const context of composerTerminalContexts) {
      const contextId = terminalContextReference(context).contextId;
      if (!referenced.has(contextId)) retained.terminals.set(contextId, context);
    }
    if (nextTerminals.length !== composerTerminalContexts.length || restoredTerminals.length > 0) {
      setComposerDraftTerminalContexts(composerDraftTarget, nextTerminals);
    }

    const liveThreadIds = new Set<string>(composerThreadContexts.map((record) => record.contextId));
    const restoredThreads = [...referenced].flatMap((contextId) => {
      if (liveThreadIds.has(contextId)) return [];
      const record = retained.threads.get(contextId);
      return record ? [record] : [];
    });
    const nextThreads = [
      ...composerThreadContexts.filter((record) => referenced.has(record.contextId)),
      ...restoredThreads,
    ];
    for (const record of composerThreadContexts) {
      if (!referenced.has(record.contextId)) retained.threads.set(record.contextId, record);
    }
    if (nextThreads.length !== composerThreadContexts.length || restoredThreads.length > 0) {
      setComposerDraftThreadContexts(composerDraftTarget, nextThreads);
    }

    const liveEnvironmentIds = new Set<string>(
      composerEnvironmentContexts.map((record) => record.contextId),
    );
    const restoredEnvironments = [...referenced].flatMap((contextId) => {
      if (liveEnvironmentIds.has(contextId)) return [];
      const record = retained.environments.get(contextId);
      return record ? [record] : [];
    });
    const nextEnvironments = [
      ...composerEnvironmentContexts.filter((record) => referenced.has(record.contextId)),
      ...restoredEnvironments,
    ];
    for (const record of composerEnvironmentContexts) {
      if (!referenced.has(record.contextId)) retained.environments.set(record.contextId, record);
    }
    if (
      nextEnvironments.length !== composerEnvironmentContexts.length ||
      restoredEnvironments.length > 0
    ) {
      setComposerDraftEnvironmentContexts(composerDraftTarget, nextEnvironments);
    }

    for (const comment of composerReviewComments) {
      const contextId = reviewCommentContextId(comment.id);
      if (!referenced.has(contextId)) {
        retained.reviewComments.set(contextId, comment);
        removeComposerDraftReviewComment(composerDraftTarget, comment.id);
      }
    }
    const liveReviewIds = new Set<string>(
      composerReviewComments.map((comment) => reviewCommentContextId(comment.id)),
    );
    for (const contextId of referenced) {
      if (liveReviewIds.has(contextId)) continue;
      const comment = retained.reviewComments.get(contextId);
      if (comment) {
        addComposerDraftReviewComment(composerDraftTarget, comment, { appendReference: false });
      }
    }

    const attachmentChanges = reconcileAttachmentContextReferences({
      referencedContextIds: referenced,
      files: composerFiles,
      images: composerImages,
      previewAnnotations: composerPreviewAnnotations,
      retained: retainedContextPayloads,
    });
    for (const annotationId of attachmentChanges.annotationIdsToRemove) {
      removeComposerDraftPreviewAnnotation(composerDraftTarget, annotationId);
    }
    for (const restored of attachmentChanges.annotationsToRestore) {
      if (restored.image) addComposerDraftImages(attachmentDraftTarget, [restored.image]);
      addComposerDraftPreviewAnnotation(composerDraftTarget, restored.annotation, {
        appendReference: false,
      });
    }
    for (const fileId of attachmentChanges.filesToRemove) {
      removeComposerDraftFile(attachmentDraftTarget, fileId);
    }
    if (attachmentChanges.filesToRestore.length > 0) {
      addComposerDraftFiles(attachmentDraftTarget, attachmentChanges.filesToRestore);
    }
    setComposerCursor(nextCursor);
    setComposerTrigger(
      cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
    );
  };
  const onPromptChangeStable = useStableCallback(onPromptChange);

  const applyPromptReplacement = (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: {
      expectedText?: string;
      expandedCursorAfterReplace?: number;
      focusEditorAfterReplace?: boolean;
      citationComment?: {
        start: number;
        sourceAnchor: AssistantCitationSourceAnchor;
        insertedSpaces: ComposerCitationCommentRequest["insertedSpaces"];
      };
    },
  ): boolean => {
    if (
      activePendingUserInput &&
      activePendingProgress?.activeQuestion?.allowCustomAnswer === false
    ) {
      return false;
    }
    const currentText = promptRef.current;
    const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
    const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
    if (
      options?.expectedText !== undefined &&
      currentText.slice(safeStart, safeEnd) !== options.expectedText
    ) {
      return false;
    }
    const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
    const nextCursor = collapseExpandedComposerCursor(
      next.text,
      options?.expandedCursorAfterReplace ?? next.cursor,
      isLiteralPendingAnswer,
    );
    const nextExpandedCursor = expandCollapsedComposerCursor(
      next.text,
      nextCursor,
      isLiteralPendingAnswer,
    );
    if (options?.citationComment) {
      composerEditorRef.current?.requestCitationComment({
        previousValue: currentText,
        value: next.text,
        citationStart: options.citationComment.start,
        sourceAnchor: options.citationComment.sourceAnchor,
        insertedSpaces: options.citationComment.insertedSpaces,
      });
    }
    promptRef.current = next.text;
    const activePendingQuestion = activePendingProgress?.activeQuestion;
    if (activePendingQuestion && activePendingUserInput) {
      onChangeActivePendingUserInputCustomAnswer(
        activePendingQuestion.id,
        next.text,
        nextCursor,
        nextExpandedCursor,
        isLiteralPendingAnswer,
      );
    } else {
      setPrompt(next.text);
      onTypingGuardDraftChange();
    }
    setComposerCursor(nextCursor);
    setComposerTrigger(
      isLiteralPendingAnswer ? null : detectComposerTrigger(next.text, nextExpandedCursor),
    );
    if (options?.focusEditorAfterReplace !== false) {
      window.requestAnimationFrame(() => {
        if (promptRef.current !== next.text) return;
        composerEditorRef.current?.focusAt(nextCursor);
      });
    }
    return true;
  };
  const applyPromptReplacementStable = useStableCallback(applyPromptReplacement);

  const readComposerSnapshot = (): {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(
        promptRef.current,
        composerCursor,
        isLiteralPendingAnswer,
      ),
      contextIds: isLiteralPendingAnswer ? [] : collectInlineContextIds(promptRef.current),
    };
  };
  const readComposerSnapshotStable = useStableCallback(readComposerSnapshot);

  const resolveActiveComposerTrigger = (): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: isLiteralPendingAnswer
        ? null
        : resolveComposerTrigger(detectComposerTrigger(snapshot.value, snapshot.expandedCursor)),
    };
  };

  const { onUsageLimitsCommand } = props;
  const onSelectComposerItem = (item: ComposerCommandItem) => {
    if (composerSelectLockRef.current) return;
    composerSelectLockRef.current = true;
    window.requestAnimationFrame(() => {
      composerSelectLockRef.current = false;
    });
    const { snapshot, trigger } = resolveActiveComposerTrigger();
    if (!trigger) return;
    if (item.type === "path") {
      if (!isPathSuggestionCurrent(item.searchTarget, trigger, environmentId, gitCwd)) return;
      const replacement = `${serializeComposerFileLink(item.path)} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "slash-command") {
      if (item.command === "model") {
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          focusEditorAfterReplace: false,
        });
        if (applied) {
          setComposerHighlightedItemId(null);
          setIsComposerModelPickerOpen(true);
        }
        return;
      }
      if (item.command === "side" || item.command === "btw") {
        if (props.sideChatDisabledReason) return;
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          trigger.rangeEnd,
          `/${item.command} `,
          { expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd) },
        );
        if (applied) setComposerHighlightedItemId(null);
        return;
      }
      if (!planModeUiEnabled) return;
      void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
      const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
        expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "provider-slash-command") {
      if (item.command.name === USAGE_LIMITS_COMMAND.name && onUsageLimitsCommand) {
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          focusEditorAfterReplace: false,
        });
        if (applied) {
          setComposerHighlightedItemId(null);
          onUsageLimitsCommand();
        }
        return;
      }
      const replacement = `/${item.command.name} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "skill") {
      const replacement = `$${item.skill.name} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "pull-request") {
      if (
        trigger.kind !== "pull-request" ||
        !composerMenuItemsRef.current.some((candidate) => candidate.id === item.id)
      ) {
        return;
      }
      const comment = buildPullRequestReferenceContext(item.pullRequest);
      const replacement = `${formatInlineContextReference(
        reviewCommentContextReference(comment),
      )} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        addComposerDraftReviewComment(composerDraftTarget, comment, {
          appendReference: false,
        });
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "thread") {
      if (trigger.kind !== "path") return;
      const shell = readThreadShell(item.thread);
      if (!shell) return;
      const record = threadContextRecord(item.thread, shell.title);
      const replacement = `${formatInlineContextReference(threadContextReference(record))} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        addComposerDraftThreadContexts(attachmentDraftTarget, [record], {
          appendReference: false,
        });
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "environment") {
      if (trigger.kind !== "path") return;
      const record = environmentContextRecord(item.environmentId, item.label);
      const replacement = `${formatInlineContextReference(environmentContextReference(record))} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        addComposerDraftEnvironmentContexts(composerDraftTarget, [record], {
          appendReference: false,
        });
        setComposerHighlightedItemId(null);
      }
      return;
    }
  };
  const onSelectComposerItemStable = useStableCallback(onSelectComposerItem);

  const onComposerMenuItemHighlighted = (itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
    setComposerHighlightedSearchKey(composerMenuSearchKey);
  };
  const onComposerMenuItemHighlightedStable = useStableCallback(onComposerMenuItemHighlighted);

  const nudgeComposerMenuHighlight = (key: "ArrowDown" | "ArrowUp") => {
    if (composerMenuItems.length === 0) return;
    const highlightedIndex = composerMenuItems.findIndex(
      (item) => item.id === composerHighlightedItemId,
    );
    const normalizedIndex = highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
    const offset = key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
    const nextItem = composerMenuItems[nextIndex];
    setComposerHighlightedItemId(nextItem?.id ?? null);
  };

  const blurMobileComposerAfterSend = () => {
    if (!isSoftwareKeyboardOpen) return;
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    setIsComposerFocused(false);
  };

  const shouldBlurMobileComposerOnSubmit = () => {
    if (!isSoftwareKeyboardOpen) return false;
    if (
      isSendBusy ||
      isSendDisabled ||
      noProviderAvailable ||
      environmentUnavailable !== null ||
      phase === "running"
    ) {
      return false;
    }
    if (activePendingProgress) {
      return activePendingProgress.isLastQuestion && Boolean(activePendingResolvedAnswers);
    }
    return showPlanFollowUpPrompt || composerSendState.hasSendableContent;
  };

  const submitComposer = (
    event?: { preventDefault: () => void },
    dispatchMode?: ComposerDispatchMode,
    submissionIntent?: ComposerSubmissionIntent,
  ) => {
    if (
      noProviderAvailable ||
      isSendDisabled ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    ) {
      event?.preventDefault();
      return;
    }
    // A send while a pasted image is still compressing would strand that image:
    // the turn snapshot wouldn't include it, and it would surface in the *next*
    // draft instead.
    if (activeThreadId && countPreparingComposerImages(attachmentTargetKey) > 0) {
      event?.preventDefault();
      toastManager.add({
        type: "info",
        title: "Still compressing a pasted image.",
        description: "Send again once its thumbnail appears.",
      });
      return;
    }
    if (pendingDraftWork.has(attachmentTargetKey)) {
      event?.preventDefault();
      toastManager.add({
        type: "info",
        title: "Still bringing attached context into this message.",
        description: "Send again once its chip resolves.",
      });
      return;
    }
    const submission = submitComposerDraft({
      prompt: promptRef.current,
      submissionTarget: activePendingProgress ? "pending-user-input" : "provider-turn",
      event,
      onSend: (sendEvent) => {
        providerInputRejectedRef.current = false;
        onSend(
          sendEvent,
          dispatchMode ??
            resolveComposerDispatchMode({
              running: phase === "running",
              alternateModifier: false,
              activeTurnDefault: followUpBehavior,
              canSteer: !isCompacting,
            }),
          submissionIntent,
        );
        return !providerInputRejectedRef.current;
      },
    });
    setComposerSubmissionError(submission.validationMessage);
    if (!submission.didDispatch) return;
    onTypingGuardSend();
    if (shouldBlurMobileComposerOnSubmit()) {
      blurMobileComposerAfterSend();
    }
  };
  const submitComposerStable = useStableCallback(submitComposer);
  const handleSubmitMessage = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    submitComposer(
      event,
      resolveComposerDispatchMode({
        running: phase === "running",
        alternateModifier: event.metaKey || event.ctrlKey,
        activeTurnDefault: followUpBehavior,
        canSteer: !isCompacting,
      }),
    );
  };
  const handleSubmitMessageStable = useStableCallback(handleSubmitMessage);
  const submitCitationAndSend = () => {
    submitComposer(
      undefined,
      resolveComposerDispatchMode({
        running: phase === "running",
        alternateModifier: false,
        activeTurnDefault: followUpBehavior,
        canSteer: !isCompacting,
      }),
    );
  };
  const submitCitationAndSendStable = useStableCallback(submitCitationAndSend);
  // A question took the editor while a citation comment was
  // unsaved. Keep the comment in the prompt that comes back afterward.
  const saveCitationDraftToPrompt = (replacedValue: string, savedValue: string) => {
    if (replacedValue !== prompt) return;
    if (promptRef.current === replacedValue) promptRef.current = savedValue;
    setPrompt(savedValue);
  };
  const saveCitationDraftToPromptStable = useStableCallback(saveCitationDraftToPrompt);
  const compactThreadContext = () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      compactDisabled ||
      noProviderAvailable ||
      activePendingApproval !== null ||
      pendingUserInputs.length > 0 ||
      phase === "running" ||
      isSendBusy ||
      !activeThreadId
    ) {
      return;
    }
    onCompactContext();
  };
  const compactThreadContextStable = useStableCallback(compactThreadContext);
  const expandMobileComposer = () => {
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandFrameRef.current = null;
      composerEditorRef.current?.focusAtEnd();
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandReleaseFrameRef.current = null;
        mobileComposerExpandInFlightRef.current = false;
      });
    });
  };
  const expandMobileComposerStable = useStableCallback(expandMobileComposer);

  const onComposerCommandKey = (key: string, event: KeyboardEvent, isTaskItem?: boolean) =>
    composerCommandKeyHandler({
      keybindings,
      sendShortcut: settings.sendShortcut,
      routeKind,
      phase,
      isCompacting,
      followUpBehavior,
      isSoftwareKeyboardOpen,
      planModeUiEnabled,
      isLiteralPendingAnswer,
      pendingUserInputs,
      promptHistoryMessages,
      promptHistoryPositionRef,
      composerDraftTarget,
      promptRef,
      composerImagesRef,
      composerFilesRef,
      composerTerminalContextsRef,
      composerPreviewAnnotations,
      composerReviewComments,
      composerEditorRef,
      composerMenuOpenRef,
      composerMenuItemsRef,
      activeComposerMenuItemRef,
      setComposerDraftPrompt,
      setComposerCursor,
      setComposerTrigger,
      setComposerHighlightedItemId,
      dismissComposerTrigger,
      toggleInteractionMode,
      nudgeComposerMenuHighlight,
      onSelectComposerItem,
      resolveActiveComposerTrigger,
      readComposerSnapshot,
      applyPromptReplacement,
      submitComposer,
    })(key, event, isTaskItem);

  const {
    stashQueue,
    isStashMenuOpen,
    setIsStashMenuOpen,
    stashPulseKey,
    restoreStashEntryStable,
    deleteStashEntryStable,
    toggleStashMenuStable,
  } = useComposerStash({
    environmentId,
    composerDraftTarget,
    promptRef,
    readAttachmentDraft: () => ({
      images: composerImagesRef.current,
      files: composerFilesRef.current,
    }),
    readTerminalContexts: () => composerTerminalContextsRef.current,
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
    isComposerDraftTargetOpen: (key) => composerDraftTargetKeyRef.current === key,
    composerEditorRef,
    isRevertingCheckpoint: () => isRevertingCheckpointRef.current,
    pendingThreadImportsRef,
    setComposerCursor,
    setComposerTrigger,
    importContextRecords,
    expandMobileComposer: expandMobileComposerStable,
  });
  const hasBlockingComposerTopDrawer = pendingUserInputs.length > 0;
  const composerControlsCollapsed = isComposerCollapsedMobile;
  // The collapsed mobile web composer keeps a second controls row inside the card.
  const showInlineRestingControls = isComposerCollapsedMobile;
  const composerControlsHidden = showInlineRestingControls && !restingControlsVisible;
  if (composerControlsHidden && isComposerModelPickerOpen) {
    setIsComposerModelPickerOpen(false);
  }
  const collapsedComposerImagePreviews =
    standaloneComposerImages.length > 0 ? (
      <ComposerRestingImagePreviews
        images={standaloneComposerImages}
        allImages={composerImages}
        resolvedTheme={resolvedTheme}
        onExpandImage={onExpandImage}
        onShowMore={expandMobileComposer}
      />
    ) : null;
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const composerMainSurfaceRef = useComposerRestingTransition(
    composerControlsCollapsed,
    restingComposerControlsRef,
    onComposerOverlayHeightChange,
    panelAnimationsActive,
    panelAnimationDurationMs,
  );
  const restingHiddenBlockCount = showInlineRestingControls
    ? restingControlsHiddenBlockCount
    : composerControlsCollapsed
      ? 0
      : expandedControlsHiddenBlockCount;
  const iconOnlyBlockCount = showInlineRestingControls
    ? restingControlsIconOnlyBlockCount
    : composerControlsCollapsed
      ? 0
      : expandedControlsIconOnlyBlockCount;
  const composerControls = (
    <ComposerControlsBar
      environmentId={environmentId}
      routeKind={routeKind}
      routeThreadRef={routeThreadRef}
      draftId={draftId}
      selectedProvider={selectedProvider}
      selectedInstanceId={selectedInstanceId}
      selectedModel={selectedModel}
      selectedProviderModels={selectedProviderModels}
      composerModelOptions={composerModelOptions}
      reportedModelSelection={reportedModelSelection}
      promptUltrathink={promptUltrathink}
      onPromptEdit={editPromptFromTraitsStable}
      planModeEnabled={settings.planModeEnabled}
      planModeUiEnabled={planModeUiEnabled}
      interactionMode={interactionMode}
      compatibleRuntimeMode={compatibleRuntimeMode}
      defaultRuntimeMode={props.defaultRuntimeMode}
      compatibleRuntimeModeOptions={compatibleRuntimeModeOptions}
      toggleInteractionMode={toggleInteractionMode}
      handleRuntimeModeChange={handleRuntimeModeChange}
      composerControlsCollapsed={composerControlsCollapsed}
      effortDisplay={settings.effortDisplay}
      permissionsShownInStrip={props.permissionsShownInStrip}
      composerControlsHidden={composerControlsHidden}
      restingHiddenBlockCount={restingHiddenBlockCount}
      iconOnlyBlockCount={iconOnlyBlockCount}
      showProviderUnavailable={showProviderUnavailable}
      providerSetupInstanceId={providerSetupInstanceId}
      onOpenProviderSetup={onOpenProviderSetup}
      providerCatalogPending={providerCatalogPending}
      isSendBusy={isSendBusy}
      multipleModelsEnabled={routeKind === "draft" && supportsMultipleModels}
      multipleModelSelections={multipleModelSelections}
      onMultipleModelSelectionsChange={setMultipleModelSelections}
      selectedModelSelection={selectedModelSelection}
      onProviderModelSelect={onProviderModelSelect}
      activeThreadModelSelection={activeThreadModelSelection}
      selectedModelForPickerWithCustomFallback={selectedModelForPickerWithCustomFallback}
      lockedProvider={lockedProvider}
      lockedContinuationGroupKey={lockedContinuationGroupKey}
      providerInstanceEntries={providerInstanceEntries}
      keybindings={keybindings}
      modelOptionsByInstance={modelOptionsByInstance}
      terminalOpen={terminalOpen}
      modelPickerOpen={isComposerModelPickerOpen}
      onModelPickerOpenChange={setIsComposerModelPickerOpen}
      modelPickerIconClassName={composerProviderState.modelPickerIconClassName}
      getModelDisabledReason={getModelDisabledReason}
    />
  );
  // An open question owns the space above the composer. Only a machine problem,
  // which is why an answer could not go through, stays beside it.
  const shelfItems = hasBlockingComposerTopDrawer
    ? props.bannerItems.filter(
        (item) =>
          item.group === "environment" && (item.variant === "error" || item.variant === "warning"),
      )
    : props.bannerItems;

  const insertComposerText = (
    text: string,
    position: "cursor" | "end",
    options?: {
      ensureLeadingBoundary?: boolean;
      citationCommentAnchor?: AssistantCitationSourceAnchor;
      clipboardData?: DataTransfer;
    },
  ): boolean => {
    if (
      text.length === 0 ||
      activePendingIsResponding ||
      (pendingUserInputs.length > 0 && !activePendingProgress?.activeQuestion) ||
      projectSelectionRequired ||
      (options?.citationCommentAnchor && !composerEditorRef.current)
    ) {
      return false;
    }
    if (options?.clipboardData) {
      text = importPastedComposerText(options.clipboardData, importContextFragment);
    }
    const prompt = promptRef.current;
    const cursor = position === "cursor" ? readComposerSnapshot().expandedCursor : prompt.length;
    const needsLeadingSpace =
      (options?.ensureLeadingBoundary ?? false) &&
      cursor > 0 &&
      !/\s/.test(prompt[cursor - 1] ?? "");
    const rangeEnd = extendReplacementRangeForTrailingSpace(prompt, cursor, text);
    return applyPromptReplacement(
      cursor,
      rangeEnd,
      needsLeadingSpace ? ` ${text}` : text,
      options?.citationCommentAnchor
        ? {
            citationComment: {
              start: cursor + (needsLeadingSpace ? 1 : 0),
              sourceAnchor: options.citationCommentAnchor,
              insertedSpaces: { before: needsLeadingSpace, after: rangeEnd === cursor },
            },
            focusEditorAfterReplace: false,
          }
        : undefined,
    );
  };
  const insertComposerTextStable = useStableCallback(insertComposerText);

  const insertAttachmentReferences = (
    references: ReadonlyArray<ComposerContextReference>,
    selection?: { start: number; end: number },
  ): boolean => {
    if (references.length === 0) return false;
    // Question answers carry attachments beside the answer, never as chips. Falling back to
    // the thread prompt here would hide the file behind a reference the question never shows.
    if (questionAttachmentTarget) return false;
    return insertAttachmentReferencesForDraft({
      target: composerDraftTarget,
      liveAttachmentTargetKey: attachmentTargetKeyRef.current,
      references,
      insertReferences: () => {
        if (selection) {
          const edit = inlineContextReferenceReplacement(promptRef.current, selection, references);
          return applyPromptReplacementStable(edit.start, edit.end, edit.text);
        }
        const text = references.map(formatInlineContextReference).join(" ");
        const inserted = insertComposerTextStable(`${text} `, "cursor", {
          ensureLeadingBoundary: true,
        });
        if (!inserted) {
          setPrompt(ensureInlineContextReferences(promptRef.current, references));
        }
        return true;
      },
    });
  };

  const { addComposerAttachments, removeComposerImage, foldPastedText } =
    useComposerAttachmentIntake({
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
    });

  const onComposerCommandKeyStable = useStableCallback(onComposerCommandKey);
  const isPathQueryActiveStable = useStableCallback(
    () => resolveActiveComposerTrigger().trigger?.kind === "path",
  );

  const insertComposerTextAtEnd: ChatComposerHandle["insertTextAtEnd"] = (text, options) => {
    const inserted = insertComposerText(text, "end", options);
    if (inserted && isComposerCollapsedMobile) {
      // Reveal the mobile editor before its focus frame.
      expandMobileComposer();
    }
    return inserted;
  };
  const insertComposerTextAtEndStable = useStableCallback(insertComposerTextAtEnd);

  const addComposerFolders = (folders: File[]) => {
    const target = folderDropTarget({
      localEnvironmentDisabled: isLocalEnvironmentDisabled(),
      environmentId,
      primaryEnvironmentId,
    });
    if (target === "remote") {
      toastManager.add({
        type: "error",
        title: "Folders can only be referenced in the local desktop environment",
      });
      return;
    }
    for (const folder of folders) {
      const path = resolveDroppedFolderPath(folder, window.desktopBridge?.getPathForFile);
      if (path === null) {
        toastManager.add({
          type: "error",
          title: `Couldn't get the path of "${folder.name}"`,
          description: "Type the folder path with @ instead.",
        });
        continue;
      }
      const inserted = insertComposerTextAtEndStable(`${serializeComposerFileLink(path)} `, {
        ensureLeadingBoundary: true,
      });
      if (!inserted) {
        toastManager.add({
          type: "error",
          title: "Unable to add folder",
          description: "The composer is busy; try again once it is ready.",
        });
        break;
      }
    }
    focusComposer();
  };
  const addComposerFoldersStable = useStableCallback(addComposerFolders);

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const { files, folders } = splitTransferredFiles(event.clipboardData);
    const plainText = event.clipboardData.getData("text/plain");
    const bypassAutoAttachment = consumePasteAsTextShortcut(pasteAsTextShortcutUntilRef);
    if (
      folders.length > 0 ||
      (activeThreadId &&
        files.length > 0 &&
        shouldHandleComposerAttachmentPaste({ files, plainText }))
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (folders.length > 0) addComposerFoldersStable(folders);
      if (files.length > 0) {
        void addComposerAttachments(files, { skipImageInlineChip: bypassAutoAttachment });
      }
      return;
    }

    if ((readPastedComposerContext(event.clipboardData)?.records.length ?? 0) > 0) return;
    if (!foldPastedText(plainText, bypassAutoAttachment)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };
  // The editor is memoized; fresh closures here re-render it on every parent
  // render, which during a stream is every delta.
  const onComposerPasteStable = useStableCallback(onComposerPaste);
  const insertContextReferencesAtCaret = (
    references: ReadonlyArray<ComposerContextReference>,
  ): boolean =>
    insertComposerText(`${references.map(formatInlineContextReference).join(" ")} `, "cursor", {
      ensureLeadingBoundary: true,
    });
  const insertContextReferencesAtCaretStable = useStableCallback(insertContextReferencesAtCaret);
  const setContextInsertionHandler = useComposerDraftStore(
    (store) => store.setContextInsertionHandler,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this composer's context insertion handler in the draft store for the current target
  useEffect(() => {
    return setContextInsertionHandler(composerDraftTarget, insertContextReferencesAtCaretStable);
  }, [composerDraftTarget, insertContextReferencesAtCaretStable, setContextInsertionHandler]);

  // Capture drops before the editor; mention handlers own native propagation and moves.
  const composerMentionDragHandlers = makeComposerMentionDragHandlers({
    insertMentionAtEnd: (text) =>
      insertComposerTextAtEndStable(text, { ensureLeadingBoundary: true }),
    insertPullRequestAtEnd: (pullRequest) => {
      const comment = buildPullRequestReferenceContext(pullRequest);
      const inserted = insertComposerTextAtEndStable(
        `${formatInlineContextReference(reviewCommentContextReference(comment))} `,
        { ensureLeadingBoundary: true },
      );
      if (inserted) {
        addComposerDraftReviewComment(composerDraftTarget, comment, { appendReference: false });
      }
      return inserted;
    },
    setDragActive: setIsDragOverComposer,
    onInsertRejected: () => {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The composer is busy; try again once it is ready.",
      });
    },
  });

  const attachDroppedThreadFile = useEffectEvent((file: File) => addComposerAttachments([file]));
  const importDroppedThread = useEffectEvent(
    async (ref: ScopedThreadRef, isActive: () => boolean) => {
      const targetKey = attachmentTargetKey;
      pendingDraftWork.begin(targetKey);
      const loadingToast = toastManager.add({
        type: "loading",
        title: "Loading thread context…",
        timeout: 0,
        data: { threadRef: routeThreadRef, hideCopyButton: true },
      });
      const importResult = await settlePromise(() =>
        importComposerThreadAttachment({
          targetKey,
          pendingImports: pendingThreadImportsRef.current,
          countReservedAttachments: countReservedAttachmentsStable,
          load: async () => {
            const result = await loadThreadTranscript({
              environmentId: ref.environmentId,
              input: { threadId: ref.threadId },
            });
            if (result._tag !== "Success") {
              throw squashAtomCommandFailure(result);
            }
            return threadContextAttachment(ref.environmentId, result.value);
          },
          isActive,
          attach: attachDroppedThreadFile,
          onLimitReached: () => {
            if (activeThreadId) {
              setThreadError(
                activeThreadId,
                `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
              );
            }
          },
        }),
      );
      if (importResult._tag === "Failure" && isActive()) {
        const error = squashAtomCommandFailure(importResult);
        toastManager.add({
          type: "error",
          title: "Unable to read the dropped thread",
          description:
            isEnvironmentRequestInvalidError(error) &&
            error.reason === "thread_transcript_too_large"
              ? "This thread exceeds the attachment size limit. Try a shorter thread."
              : "Check that its environment is connected and up to date, then try again.",
        });
      }
      toastManager.close(loadingToast);
      pendingDraftWork.end(targetKey);
    },
  );

  useThreadContextDrop(composerFormRef, environmentId, attachmentTargetKey, (refs, isActive) => {
    const records = refs.flatMap((ref) => {
      // The agent reads a linked machine's thread itself, like the `@` picker's; any other
      // machine's comes in as its transcript.
      if (ref.environmentId !== environmentId && !linkedEnvironments.has(ref.environmentId)) {
        void importDroppedThread(
          ref,
          () => isActive() && attachmentTargetKeyRef.current === attachmentTargetKey,
        );
        return [];
      }
      const shell = readThreadShell(ref);
      return shell ? [threadContextRecord(ref, shell.title)] : [];
    });
    if (records.length === 0) return;
    if (questionAttachmentTarget !== null) {
      const canAnswer =
        canOperateThread &&
        !activePendingIsResponding &&
        activePendingProgress?.activeQuestion?.allowCustomAnswer !== false;
      const text = `${records
        .map((record) => formatInlineContextReference(threadContextReference(record)))
        .join(" ")} `;
      const snapshot = readComposerSnapshotStable();
      const cursor = snapshot.expandedCursor;
      const leadingSpace = cursor > 0 && !/\s/.test(snapshot.value[cursor - 1] ?? "");
      const inserted =
        canAnswer &&
        applyPromptReplacementStable(
          cursor,
          extendReplacementRangeForTrailingSpace(snapshot.value, cursor, text),
          leadingSpace ? ` ${text}` : text,
        );
      if (!inserted) {
        toastManager.add({
          type: "error",
          title: "Unable to add thread",
          description: "The composer is busy; try again once it is ready.",
        });
        return;
      }
      addComposerDraftThreadContexts(questionAttachmentTarget, records, {
        appendReference: false,
      });
      if (isComposerCollapsedMobile) expandMobileComposerStable();
    } else {
      addComposerDraftThreadContexts(composerDraftTarget, records);
    }
  });

  const onComposerMentionDragLeaveCapture = (event: React.DragEvent<HTMLFormElement>) => {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) return;
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsDragOverComposer(false);
  };

  // Escape can cancel without dragleave; clear highlights on bubbling dragend.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window dragend listener clears the drop highlight when a drag is cancelled without dragleave
  useEffect(() => {
    if (!isDragOverComposer) return;
    const onWindowDragEnd = () => {
      setIsDragOverComposer(false);
    };
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, [isDragOverComposer]);
  const handleInterruptPrimaryAction = () => {
    void onInterrupt();
  };
  const handleInterruptPrimaryActionStable = useStableCallback(handleInterruptPrimaryAction);
  const handleImplementPlanInNewThreadPrimaryAction = () => {
    void onImplementPlanInNewThread();
  };
  const handleImplementPlanInNewThreadPrimaryActionStable = useStableCallback(
    handleImplementPlanInNewThreadPrimaryAction,
  );
  const scheduleComposerCollapseCheck = () => {
    if (!isMobileViewport || mobileComposerExpandInFlightRef.current) {
      return;
    }
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (mobileComposerExpandInFlightRef.current) {
        return;
      }
      const composerSurface = composerSurfaceRef.current;
      const composerForm = composerFormRef.current;
      const activeElement = document.activeElement;
      if (isInsideRestingComposerControlScope(activeElement)) {
        return;
      }
      if (
        activeElement instanceof Node &&
        ((composerSurface && composerSurface.contains(activeElement)) ||
          (composerForm && composerForm.contains(activeElement)))
      ) {
        return;
      }
      setIsComposerFocused(false);
    });
  };
  const scheduleComposerCollapseCheckStable = useStableCallback(scheduleComposerCollapseCheck);

  // Question dismissal unmounts focused controls without firing blur.
  const activePendingUserInputRequestId = activePendingUserInput?.requestId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules the collapse check after a dismissed question unmounts focused controls without a blur
  useEffect(() => {
    if (activePendingUserInputRequestId !== null) return;
    scheduleComposerCollapseCheckStable();
  }, [activePendingUserInputRequestId, scheduleComposerCollapseCheckStable]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels pending blur and mobile expand animation frames when the composer unmounts
  useEffect(() => {
    return () => {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
      }
      if (mobileComposerExpandFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
      }
      if (mobileComposerExpandReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
      }
    };
  }, []);

  const openModelPicker = () => {
    if (composerControlsHidden) {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
        composerBlurFrameRef.current = null;
      }
      setIsComposerFocused(true);
    }
    setIsComposerModelPickerOpen(true);
  };
  const openModelPickerStable = useStableCallback(openModelPicker);

  useImperativeHandle(
    composerRef,
    () => ({
      focusAtEnd: () => {
        composerEditorRef.current?.focusAtEnd();
      },
      focusAt: (cursor: number) => {
        composerEditorRef.current?.focusAt(cursor);
      },
      addDroppedFiles: (files: File[]) => {
        void addComposerAttachments(files).then((inserted) => {
          if (!inserted) focusComposer();
        });
      },
      addDroppedFolders: addComposerFoldersStable,
      hasPendingAttachments: () =>
        countPreparingComposerImages(attachmentTargetKey) > 0 ||
        pendingDraftWork.has(attachmentTargetKey),
      insertTextAtEnd: insertComposerTextAtEndStable,
      pasteTextAtEnd: (text: string, options) => {
        const shortcutArmed = consumePasteAsTextShortcut(pasteAsTextShortcutUntilRef);
        const bypassAutoAttachment = options?.bypassAutoAttachment === true || shortcutArmed;
        const promptLength = promptRef.current.length;
        if (
          !foldPastedText(text, bypassAutoAttachment, {
            start: promptLength,
            end: promptLength,
          })
        ) {
          return false;
        }
        focusComposer();
        return true;
      },
      citeAssistantText: (citation, sourceAnchor) =>
        insertComposerTextStable(
          formatAssistantCitationForComposer(citation, citation.comment),
          "cursor",
          { ensureLeadingBoundary: true, citationCommentAnchor: sourceAnchor },
        ),
      openModelPicker: openModelPickerStable,
      stepReasoningEffort: (direction) => {
        if (noProviderAvailable || pendingUserInputs.length > 0 || isEditingQueuedMessage) {
          return;
        }
        const change = getComposerReasoningStep({
          provider: selectedProvider,
          instanceId: selectedInstanceId,
          model: selectedModel,
          models: selectedProviderModels,
          modelOptions: composerModelOptions?.[selectedInstanceId],
          reportedModelSelection,
          prompt: promptRef.current,
          cursor: readComposerSnapshotStable().expandedCursor,
          planModeEnabled: settings.planModeEnabled,
          direction,
        });
        if (!change) return;
        useComposerDraftStore
          .getState()
          .setProviderModelOptions(composerDraftTarget, selectedProvider, change.modelOptions, {
            instanceId: selectedInstanceId,
            model: selectedModel,
            persistSticky: true,
          });
        if (change.prompt !== promptRef.current) {
          applyPromptReplacementStable(0, promptRef.current.length, change.prompt, {
            expandedCursorAfterReplace: change.cursor,
          });
        }
      },
      toggleModelPicker: () => {
        if (isComposerModelPickerOpen) {
          setIsComposerModelPickerOpen(false);
        } else {
          openModelPickerStable();
        }
      },
      openControl: (command) => {
        if (composerBlurFrameRef.current !== null) {
          window.cancelAnimationFrame(composerBlurFrameRef.current);
          composerBlurFrameRef.current = null;
        }
        flushSync(() => setIsComposerFocused(true));
        const shell = composerFormRef.current?.closest('[data-slot="composer-shell"]');
        const trigger = Array.from(
          shell?.querySelectorAll<HTMLButtonElement>(
            `button[data-composer-shortcut~="${command}"]:not(:disabled)`,
          ) ?? [],
        ).find(
          (element) =>
            !element.closest("[inert]") && element.checkVisibility({ visibilityProperty: true }),
        );
        if (!trigger) return;
        trigger.focus({ preventScroll: true });
        if (command === "composer.mode") markOpenToPermissions(trigger);
        if (command === "composer.effort") markOpenToEffort(trigger);
        trigger.click();
      },
      compactContext: compactThreadContextStable,
      isModelPickerOpen: () => isComposerModelPickerOpen,
      isCaretAtStart: () => {
        const range = composerEditorRef.current?.readSelectionRange();
        return range !== undefined && range.start === 0 && range.end === 0;
      },
      readSnapshot: () => {
        return readComposerSnapshotStable();
      },
      resetCursorState: (options?: {
        cursor?: number;
        prompt?: string;
        detectTrigger?: boolean;
      }) => {
        const promptForState = options?.prompt ?? promptRef.current;
        const cursor = clampCollapsedComposerCursor(
          promptForState,
          options?.cursor ?? 0,
          isLiteralPendingAnswer,
        );
        setComposerHighlightedItemId(null);
        setComposerCursor(cursor);
        resetComposerTrigger(
          options?.detectTrigger && !isLiteralPendingAnswer
            ? detectComposerTrigger(
                promptForState,
                expandCollapsedComposerCursor(promptForState, cursor),
              )
            : null,
        );
      },
      addTerminalContext: (selection: TerminalContextSelection) => {
        if (!activeThread || isChoiceOnlyPendingQuestion || isLiteralPendingAnswer) return;
        const snapshot = readComposerSnapshotStable();
        const context = {
          id: randomUUID(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
          ...selection,
        };
        const insertion = insertInlineContextReference(
          snapshot.value,
          snapshot.expandedCursor,
          terminalContextReference(context),
        );
        const nextCollapsedCursor = collapseExpandedComposerCursor(
          insertion.prompt,
          insertion.cursor,
        );
        const inserted = insertComposerDraftTerminalContext(
          composerDraftTarget,
          insertion.prompt,
          context,
          composerTerminalContexts.length,
        );
        if (!inserted) return;
        promptRef.current = insertion.prompt;
        setComposerCursor(nextCollapsedCursor);
        setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCollapsedCursor);
        });
      },
      getSendContext: () => ({
        answeringPendingUserInput: activePendingProgress !== null,
        shownPendingApprovalIds: pendingApprovals
          .map((approval) => approval.requestId)
          .filter((requestId) => !heldRequestIds.has(requestId)),
        prompt: promptRef.current,
        images: composerImagesRef.current,
        files: composerFilesRef.current,
        terminalContexts: composerTerminalContextsRef.current,
        previewAnnotations: composerPreviewAnnotations,
        reviewComments: composerReviewComments,
        threadContexts: composerThreadContexts,
        environmentContexts: composerEnvironmentContexts,
        selectedPromptEffort,
        selectedModelSelection,
        multipleModelSelections:
          routeKind === "draft" && multipleModelSelections !== null
            ? multipleModelSelections.map((selection) =>
                selection.instanceId === selectedModelSelection.instanceId &&
                selection.model === selectedModelSelection.model
                  ? selectedModelSelection
                  : selection,
              )
            : null,
        providerAvailable:
          multipleModelSelections !== null ||
          (!noProviderAvailable && providerSendBlockReason === null),
        selectedProvider,
        selectedModel,
        selectedProviderModels,
        interactionMode,
        interactionModeEnabled: planModeUiEnabled,
      }),
      setMultipleModelSelections,
      validateProviderInput: (providerInput: string) => {
        const validationMessage = getComposerSubmissionValidationMessage({
          prompt: promptRef.current,
          providerInput,
          submissionTarget: "provider-turn",
        });
        providerInputRejectedRef.current = validationMessage !== null;
        setProviderInputSubmissionError(validationMessage);
        return validationMessage === null;
      },
    }),
    [
      activeThread,
      addComposerAttachments,
      addComposerFoldersStable,
      foldPastedText,
      composerDraftTarget,
      composerModelOptions,
      isEditingQueuedMessage,
      composerCursor,
      activePendingProgress,
      pendingApprovals,
      heldRequestIds,
      composerTerminalContexts,
      insertComposerDraftTerminalContext,
      insertComposerTextStable,
      insertComposerTextAtEndStable,
      promptRef,
      composerImagesRef,
      composerFilesRef,
      composerTerminalContextsRef,
      composerPreviewAnnotations,
      composerReviewComments,
      composerThreadContexts,
      composerEnvironmentContexts,
      focusComposer,
      environmentId,
      primaryEnvironmentId,
      isChoiceOnlyPendingQuestion,
      isLiteralPendingAnswer,
      pendingUserInputs.length,
      projectSelectionRequired,
      applyPromptReplacementStable,
      isComposerModelPickerOpen,
      openModelPickerStable,
      readComposerSnapshotStable,
      resetComposerTrigger,
      setComposerTrigger,
      selectedModel,
      selectedInstanceId,
      reportedModelSelection,
      settings.planModeEnabled,
      selectedModelSelection,
      multipleModelSelections,
      setMultipleModelSelections,
      routeKind,
      noProviderAvailable,
      providerSendBlockReason,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
      interactionMode,
      planModeUiEnabled,
      compactThreadContextStable,
    ],
  );

  // Built outside the form's JSX so typing, which rebuilds that JSX, leaves them cached.
  const composerAttachmentMediaRow =
    !isComposerCollapsedMobile &&
    (uncommittedSnapShotIds.length > 0 ||
      composerVideos.length > 0 ||
      standaloneComposerImages.length > 0 ||
      preparingComposerImages.length > 0) ? (
      <ComposerAttachmentMediaRow
        images={composerImages}
        expandedImages={standaloneComposerImages}
        preparingImages={preparingComposerImages}
        videos={composerVideos}
        pendingSnapShotAnimations={pendingSnapShotAnimations}
        pendingSnapShotIds={pendingSnapShotIds}
        uncommittedSnapShotIds={uncommittedSnapShotIds}
        nonPersistedImageIds={nonPersistedComposerImageIds}
        snapShotAnimations={settings.snapShotAnimations}
        supportsAttachmentUploads={supportsAttachmentUploads}
        maxFileAttachmentBytes={maxFileAttachmentBytes}
        environmentId={environmentId}
        attachmentDraftTarget={attachmentDraftTarget}
        canOperateThread={canOperateThread}
        onExpandImage={onExpandImage}
        onFileOpen={onFileOpen}
        onRemoveImage={removeComposerImage}
        onRemoveFile={removeComposerFileFromDraft}
      />
    ) : null;
  const composerAttachmentFileList =
    !isComposerCollapsedMobile && composerOtherFiles.length > 0 ? (
      <ComposerAttachmentFileList
        files={composerOtherFiles}
        resolvedTheme={resolvedTheme}
        supportsAttachmentUploads={supportsAttachmentUploads}
        maxFileAttachmentBytes={maxFileAttachmentBytes}
        fileStagingLimit={fileStagingLimit}
        environmentId={environmentId}
        attachmentDraftTarget={attachmentDraftTarget}
        canOperateThread={canOperateThread}
        onPreviewFile={setPreviewFileId}
        onRemoveFile={removeComposerFileFromDraft}
      />
    ) : null;
  const composerAttachButton = showComposerAttachAction ? (
    <ComposerAttachButton
      addComposerAttachments={addComposerAttachments}
      focusComposer={focusComposer}
    />
  ) : null;
  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposerStable}
      onFocusCapture={(event) => {
        const activeElement = event.target;
        if (
          activeElement instanceof Element &&
          activeElement.closest('[data-testid="composer-editor"]')
        ) {
          onTypingGuardFocus();
        }
        if (composerControlsCollapsed && isInsideRestingComposerControlScope(activeElement)) {
          return;
        }
        if (isInsideCollapsedComposerControls(activeElement)) {
          return;
        }
        if (composerBlurFrameRef.current !== null) {
          window.cancelAnimationFrame(composerBlurFrameRef.current);
          composerBlurFrameRef.current = null;
        }
        setIsComposerFocused(true);
      }}
      onBlurCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-testid="composer-editor"]')
        ) {
          onTypingGuardBlur();
        }
        scheduleComposerCollapseCheck();
      }}
      onDragEnterCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDragEnter(event);
      }}
      onDragOverCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDragOver(event);
      }}
      onDragLeaveCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        onComposerMentionDragLeaveCapture(event);
      }}
      onDropCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDrop(event);
      }}
      className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
      data-chat-composer-form="true"
      {...threadContextDropTargetProps()}
    >
      <ComposerBanner.Dock>
        <ComposerBanner.Column>
          <ComposerBannerStack items={shelfItems} />
          {showComposerTopDrawer ? (
            <ComposerBanner.Attachment>
              <ComposerBanner.Root data-chat-composer-top-drawer="true" variant="info">
                {pendingUserInputs.length > 0 ? (
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    cwd={gitCwd ?? undefined}
                    threadRef={routeThreadRef}
                    disabled={!canOperateThread}
                    respondingRequestIds={
                      activePendingIsResponding && activePendingUserInput
                        ? [...respondingRequestIds, activePendingUserInput.requestId]
                        : respondingRequestIds
                    }
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onToggleOption={onSelectActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                    onDismiss={onDismissActivePendingUserInput}
                  />
                ) : !isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan ? (
                  <ComposerPlanFollowUpBanner
                    key={activeProposedPlan.id}
                    planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                  />
                ) : null}
              </ComposerBanner.Root>
            </ComposerBanner.Attachment>
          ) : null}
        </ComposerBanner.Column>
        <ComposerStashBadge
          count={stashQueue.length}
          menuOpen={isStashMenuOpen}
          pulseKey={stashPulseKey}
          onToggleMenu={toggleStashMenuStable}
        />
      </ComposerBanner.Dock>
      <div className="relative">
        <ComposerSurface.Main
          ref={composerMainSurfaceRef}
          data-inline-resting-controls="true"
          className={composerProviderState.composerFrameClassName}
        >
          <div
            ref={composerSurfaceRef}
            data-chat-composer-surface="true"
            data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
            className={cn(
              "rounded-2xl transition-[background-color] duration-200",
              "in-data-[thread-context-over]:bg-accent/45 in-data-[thread-context-over]:ring-1 in-data-[thread-context-over]:ring-inset in-data-[thread-context-over]:ring-primary/70",
              isDragOverComposer ? "bg-accent/45 ring-1 ring-inset ring-primary/70" : null,
              projectSelectionRequired ? "opacity-75" : null,
              composerProviderState.composerSurfaceClassName,
            )}
          >
            {showCollapsedMobilePromptRow ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  data-chat-composer-transition-prompt="true"
                  className={cn(
                    "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-sm focus:outline-none",
                    prompt.trim() ? "text-foreground" : "text-placeholder",
                  )}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={expandMobileComposerStable}
                  aria-label="Expand composer"
                >
                  {prompt.trim() ||
                    (showProviderUnavailable ? "Enable a provider in Settings" : "Ask anything...")}
                </button>
                {collapsedComposerImagePreviews}
                <button
                  type="button"
                  data-chat-composer-transition-actions="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover disabled:opacity-64"
                  disabled={collapsedComposerPrimaryActionDisabled}
                  aria-label={collapsedComposerPrimaryActionLabel}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (showResumeAction) onResume();
                    else if (props.resumeCompactionTokens !== null && !props.keepFullHistory)
                      expandMobileComposer();
                    else submitComposer();
                  }}
                >
                  {showResumeAction ? (
                    <PlayIcon className="size-4 fill-current" aria-hidden="true" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M8 3L8 13M8 3L4 7M8 3L12 7"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </div>
            ) : null}

            <div
              ref={(node) => {
                setComposerMenuAnchor(node);
                const stopObserving = observeWrappedPrompt(node);
                return () => {
                  setComposerMenuAnchor(null);
                  stopObserving?.();
                };
              }}
              data-chat-composer-body="true"
              className={cn(
                "relative px-4 pb-2",
                "pt-3.5 sm:pt-4",
                isComposerCollapsedMobile && "hidden",
              )}
            >
              {isStashMenuOpen && !composerMenuOpen && (
                <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                  <ComposerStashMenu
                    composerFormRef={composerFormRef}
                    entries={stashQueue}
                    stashShortcutLabel={shortcutLabelForCommand(keybindings, "composer.stash", {
                      context: {
                        terminalFocus: false,
                        terminalOpen,
                        modelPickerOpen: false,
                      },
                    })}
                    onRestore={restoreStashEntryStable}
                    onDelete={deleteStashEntryStable}
                    onClose={() => setIsStashMenuOpen(false)}
                  />
                </ComposerCommandMenuLayer>
              )}

              <div role="status" aria-atomic="true" className="sr-only">
                {composerSuggestionsVisible && composerMenuItems.length === 0
                  ? isComposerMenuLoading
                    ? composerTriggerKind === "pull-request"
                      ? "Finding pull request..."
                      : "Searching workspace files..."
                    : composerMenuEmptyState
                  : ""}
              </div>
              {composerSuggestionsVisible && (
                <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                  <ComposerCommandMenu
                    listId={composerSuggestionListId}
                    items={composerMenuItems}
                    resolvedTheme={resolvedTheme}
                    isLoading={isComposerMenuLoading}
                    triggerKind={composerTriggerKind}
                    emptyStateText={composerMenuEmptyState}
                    activeItemId={activeComposerMenuItem?.id ?? null}
                    onHighlightedItemChange={onComposerMenuItemHighlightedStable}
                    onSelect={onSelectComposerItemStable}
                  />
                </ComposerCommandMenuLayer>
              )}

              {!isComposerCollapsedMobile &&
                pendingUserInputs.length === 0 &&
                editingQueuedAttachments !== null &&
                editingQueuedAttachments.length > 0 && (
                  <ComposerQueuedAttachmentRow
                    attachments={editingQueuedAttachments}
                    onRemove={onRemoveEditingQueuedAttachment}
                  />
                )}

              {composerAttachmentMediaRow}

              {composerAttachmentFileList}

              <div className="relative">
                {previewFile ? (
                  <ComposerFilePreviewDialog
                    file={previewFile}
                    onRemove={removeComposerFileFromDraft}
                    onPreviewFileIdChange={setPreviewFileId}
                  />
                ) : null}
                <ComposerContextActionsContext value={composerContextActions}>
                  <ComposerPromptEditor
                    draftKey={composerDraftTargetKey}
                    // Switching threads lands focus here, so the label names the thread.
                    ariaLabel={activeThread ? `Message ${activeThread.title}` : "Message"}
                    suggestionListId={composerSuggestionListId}
                    activeSuggestionId={
                      composerSuggestionListVisible && activeComposerMenuItem
                        ? composerSuggestionOptionId(
                            composerSuggestionListId,
                            activeComposerMenuItem.id,
                          )
                        : undefined
                    }
                    editorRef={composerEditorRef}
                    richTextEnabled={settings.composerRichTextEnabled}
                    literalText={isLiteralPendingAnswer}
                    isPathQueryActive={isPathQueryActiveStable}
                    value={activePendingProgress ? activePendingProgress.customAnswer : prompt}
                    cursor={composerCursor}
                    contextRecords={composerContextRecords}
                    buildContextClipboardFragment={buildContextClipboardFragmentStable}
                    importContextFragment={importContextFragmentStable}
                    skills={selectedProviderSkills}
                    className={cn(showMobilePendingAnswerActions && "max-sm:pb-12")}
                    onChange={onPromptChangeStable}
                    onCommandKeyDown={onComposerCommandKeyStable}
                    onPageScrollKeyDown={onPageScrollKeyDown}
                    onPageScrollKeyUp={onPageScrollKeyUp}
                    onPageScrollRelease={onPageScrollRelease}
                    onCitationSubmitAndSend={submitCitationAndSendStable}
                    onCitationDraftSave={saveCitationDraftToPromptStable}
                    onPaste={onComposerPasteStable}
                    placeholder={
                      isComposerApprovalState
                        ? activePendingApproval?.supportsFeedback
                          ? "Send feedback to decline this request"
                          : "Send a message to decline and redirect the agent"
                        : activePendingProgress
                          ? isChoiceOnlyPendingQuestion
                            ? "Choose an option above"
                            : "Type your own answer, or leave this blank to use the selected option"
                          : showPlanFollowUpPrompt && activeProposedPlan
                            ? "Add feedback to refine the plan, or leave this blank to implement it"
                            : projectSelectionRequired
                              ? "Choose a project above to start a thread"
                              : showProviderUnavailable
                                ? "Enable a provider in Settings to send a message"
                                : DEFAULT_COMPOSER_PLACEHOLDER
                    }
                    disabled={
                      projectSelectionRequired ||
                      isChoiceOnlyPendingQuestion ||
                      activePendingIsResponding
                    }
                  />
                </ComposerContextActionsContext>
                {showMobilePendingAnswerActions ? (
                  <div
                    data-chat-composer-mobile-pending-actions="true"
                    className="absolute bottom-0 right-0 flex items-center justify-end gap-1"
                  >
                    <ComposerPrimaryActions
                      compact
                      canOperateThread={canOperateThread}
                      pendingAction={pendingPrimaryAction}
                      isRunning={false}
                      canInterrupt={false}
                      showPlanFollowUpPrompt={false}
                      promptHasText={false}
                      isSendBusy={isSendBusy}
                      sendDisabledReason={sendDisabledReason}
                      isEnvironmentUnavailable={
                        environmentUnavailable !== null ||
                        noProviderAvailable ||
                        projectSelectionRequired
                      }
                      isPreparingWorktree={false}
                      hasSendableContent={false}
                      preserveComposerFocusOnPointerDown
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={handleInterruptPrimaryActionStable}
                      onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryActionStable}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            <ComposerPromptLengthValidation
              message={providerInputSubmissionError ?? composerSubmissionError}
            />

            {isComposerCollapsedMobile ? null : (
              <div
                data-chat-composer-footer="true"
                className={cn(
                  "flex min-w-0 flex-nowrap items-center overflow-visible px-2 pb-2",
                  pendingUserInputs.length > 0 && "pt-2",
                  showMobilePendingAnswerActions && "hidden sm:flex",
                )}
              >
                {composerAttachButton ? <div className="me-2">{composerAttachButton}</div> : null}
                <div
                  data-chat-composer-actions="right"
                  data-chat-composer-transition-actions="true"
                  data-chat-composer-primary-actions-compact={
                    isComposerPrimaryActionsCompact ? "true" : "false"
                  }
                  className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-2"
                >
                  <div
                    ref={attachExpandedComposerControls}
                    data-chat-composer-controls="footer"
                    data-chat-composer-footer-controls="true"
                    className="relative flex min-w-0 flex-1 items-center justify-end gap-0.5"
                  >
                    {composerControls}
                  </div>
                  <ComposerFooterPrimaryActions
                    compact={isComposerPrimaryActionsCompact}
                    canOperateThread={canOperateThread}
                    activeContextWindow={
                      settings.contextWindowMeterEnabled ? activeContextWindow : null
                    }
                    reserveContextWindowMeter={reserveContextWindowMeter}
                    activeThreadModelDisplayName={activeThreadModelDisplayName}
                    pendingAction={pendingPrimaryAction}
                    isRunning={phase === "running"}
                    canInterrupt={canInterrupt}
                    followUpBehavior={followUpBehavior}
                    canSteer={!isCompacting}
                    alternateShortcutLabel={shortcutLabelForCommand(
                      keybindings,
                      "composer.sendAlternate",
                      {
                        context: {
                          composerFocus: true,
                          draftThreadRoute: routeKind === "draft",
                          turnRunning: true,
                          composerRequiresModifier: composerRequiresModifier(
                            settings.sendShortcut,
                            prompt,
                          ),
                        },
                      },
                    )}
                    showPlanFollowUpPrompt={
                      pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                    }
                    promptHasText={prompt.trim().length > 0}
                    isSendBusy={isSendBusy}
                    sendDisabledReason={sendDisabledReason}
                    isEnvironmentUnavailable={
                      environmentUnavailable !== null ||
                      noProviderAvailable ||
                      projectSelectionRequired
                    }
                    isPreparingWorktree={isPreparingWorktree}
                    hasSendableContent={composerSendState.hasSendableContent}
                    canResume={showResumeAction}
                    preserveComposerFocusOnPointerDown={isMobileViewport}
                    isEditingQueuedMessage={isEditingQueuedMessage}
                    onSubmitMessage={handleSubmitMessageStable}
                    onResume={onResume}
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={handleInterruptPrimaryActionStable}
                    onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryActionStable}
                    compactBeforeSendTokens={props.resumeCompactionTokens}
                    keepFullHistory={props.keepFullHistory}
                    onToggleKeepFullHistory={props.onToggleKeepFullHistory}
                    compactDisabled={compactDisabled || noProviderAvailable || isSendBusy}
                    compactDisabledReason={resolvedCompactDisabledReason}
                    {...(compactCommandAvailable
                      ? { onCompactContext: compactThreadContextStable }
                      : {})}
                  />
                </div>
              </div>
            )}
            {showInlineRestingControls ? (
              <div className="h-8">
                <div
                  ref={setInlineRestingControlsHost}
                  className="absolute bottom-2 inset-x-4 min-w-0"
                >
                  <div
                    ref={attachRestingComposerControls}
                    data-chat-composer-resting-controls="true"
                    aria-hidden={restingControlsVisible ? undefined : true}
                    inert={restingControlsVisible ? undefined : true}
                    className={cn(
                      "relative flex w-max min-w-0 max-w-full items-center gap-1 text-muted-foreground/70 [&_button]:text-xs!",
                      !restingControlsVisible && "invisible",
                    )}
                  >
                    {composerControls}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </ComposerSurface.Main>
      </div>
    </form>
  );
});
