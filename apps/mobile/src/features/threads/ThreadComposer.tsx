import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import type { ComposerTextPaste } from "../../native/T3ComposerEditor.types";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { pastedTextDisposition, replaceTextSelection } from "@t3tools/client-runtime/text-paste";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ChatAttachment,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerConfig as T3ServerConfig,
  type UsageLimitsReport,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  hasProviderUsageLimits,
  isUsageLimitsCommand,
} from "@t3tools/shared/usageLimits";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Keyboard, Platform, View, type ViewStyle } from "react-native";
import { composerImageGallery } from "../../lib/composerImageGallery";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadsAtom,
} from "../../state/composer-attachment-uploads";
import Animated, {
  FadeIn,
  FadeOut,
  type LayoutAnimationFunction,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  getComposerDraftSnapshot,
  composerDraftsAtom,
  setComposerDraftText,
  composerContextImportsAtom,
  countComposerDraftAttachmentsAfterSelection,
  useComposerDraft,
} from "../../state/use-composer-drafts";
import { appAtomRegistry } from "../../state/atom-registry";
import type { ComposerDocumentAttachment } from "../../lib/composerContext";
import { useProject, useThreadShells } from "../../state/entities";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import { AppText as Text } from "../../components/ui/AppText";
import { ComposerAttachmentButton } from "./ComposerAttachmentButton";
import {
  ComposerAttachmentStrip,
  ComposerAttachmentThumbnail,
} from "../../components/ComposerAttachmentStrip";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import { fileRoutePathSegments } from "../files/filePath";
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarRow,
} from "../../components/ComposerToolbar";
import { ProviderIcon } from "../../components/ProviderIcon";
import {
  composerStripAttachments,
  type DraftComposerFileAttachment,
} from "../../lib/composerImages";
import {
  buildModelOptions,
  groupByProvider,
  isModelSelectionUnavailable,
} from "../../lib/modelOptions";
import { useScaledTextRole, type ScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { Menu } from "../../components/ui/Menu";
import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";
import type { FollowUpBehavior } from "../../lib/followUpBehavior";
import {
  resolveComposerSendPresentation,
  type ComposerSendPresentation,
} from "./composerSendPresentation";
import { ComposerCommandPopover } from "./ComposerCommandPopover";
import { ComposerPopoverAnchor } from "./ComposerPopoverAnchor";
import { ComposerQueuedEditAttachments } from "./ComposerQueuedEdit";
import { useComposerCommandMenu } from "./use-composer-command-menu";
import {
  ComposerDictationCancelAction,
  ComposerDictationDraftContent,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import { ComposerVoiceModeButton, ComposerVoiceStrip } from "../voice-mode/ComposerVoiceMode";
import { useVoiceModePhase, useVoiceModeThreadLifecycle } from "../voice-mode/useVoiceMode";
import { voiceMode, voiceModeSupported } from "../voice-mode/voiceMode";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "./ThreadSettingsSheet";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";

export const COMPOSER_COLLAPSED_CHROME = 60;

const COLLAPSED_EDITOR_DEFAULT_INSET = 6;
// iOS puts line-height slack above glyphs. DM Sans's lowercase midline is
// descender (0.31em) + half x-height (0.504em) above the line bottom.
const LOWERCASE_MIDLINE_EM = 0.562;

function lowercaseMidline(text: ScaledTextRole): number {
  return text.lineHeight - LOWERCASE_MIDLINE_EM * text.fontSize;
}

function collapsedEditorInset(text: ScaledTextRole): number {
  const shift = lowercaseMidline(text) - lowercaseMidline(MOBILE_TYPOGRAPHY.body);
  return Math.max(0, Math.round(COLLAPSED_EDITOR_DEFAULT_INSET - shift));
}

export const COMPOSER_EXPANDED_CHROME = 156;

export interface ThreadComposerProps {
  readonly canOperateThread: boolean;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly environmentLabel: string | null;
  readonly threadSyncPhase?: "loading" | "syncing" | null;
  readonly selectedThread: EnvironmentThreadShell;
  readonly reportedModelSelection?: ModelSelection | null;
  readonly hasCompactableConversation: boolean;
  readonly serverConfig: T3ServerConfig | null;
  readonly queueCount: number;
  readonly activeThreadBusy: boolean;
  readonly canStopThread: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string | null;
  readonly sendBlockedReason?: string | null;
  readonly draftKey?: string;
  readonly queuedEdit?: {
    readonly existingAttachments: ReadonlyArray<ChatAttachment>;
    readonly saving: boolean;
    readonly onRemoveExistingAttachment: (attachmentId: string) => void;
  } | null;
  readonly followUpBehavior: FollowUpBehavior;
  readonly canSteerActiveTurn: boolean;
  readonly hidden: boolean;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: () => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onNativePasteText: (paste: ComposerTextPaste) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  /** Present while the thread's queue is held. */
  readonly onResumeQueue: (() => Promise<void>) | null;
  readonly onSendMessage: (followUp?: ActiveTurnComposerAction) => Promise<MessageId | null>;
  readonly onShowUsageLimits: (report: UsageLimitsReport | null) => void;
  readonly canSwitchProvider: boolean;
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly onEditorFocusChange?: (focused: boolean) => void;
}

// Android gets NO layout transition: the composer rides the keyboard via KeyboardStickyView
// (frame-synced to the IME), and a time-based morph running alongside that translate reads as
// jitter.
export const COMPOSER_TRANSITION_DURATION_MS = 220;
// Side panes already animate the dock's width. Nested horizontal layout
// transitions would leave the surface trailing its toolbar's new position.
const composerHeightTransition: LayoutAnimationFunction = (values) => {
  "worklet";
  const timing = {
    duration: COMPOSER_TRANSITION_DURATION_MS,
    reduceMotion: ReduceMotion.System,
  };
  return {
    initialValues: {
      originX: values.targetOriginX,
      originY: values.currentOriginY,
      width: values.targetWidth,
      height: values.currentHeight,
    },
    animations: {
      originX: values.targetOriginX,
      originY: withTiming(values.targetOriginY, timing),
      width: values.targetWidth,
      height: withTiming(values.targetHeight, timing),
    },
  };
};
export const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === "android" ? undefined : composerHeightTransition;

const COMPOSER_ATTACHMENT_ENTERING =
  Platform.OS === "android"
    ? FadeIn.duration(160)
    : FadeIn.delay(COMPOSER_TRANSITION_DURATION_MS).duration(160).reduceMotion(ReduceMotion.System);

const AnimatedGlassSurface = Animated.createAnimatedComponent(GlassSurface);

const FOLLOW_UP_ACTION_LABEL = {
  queue: "Queue",
  steer: "Steer now",
  restart: "Restart turn",
} as const;

const FOLLOW_UP_ACTION_SUBTITLE = {
  queue: "Run after the current turn",
  steer: "Interrupt what the agent is doing",
  restart: "Start the turn over with this message",
} as const;

function SendActionButton(props: {
  readonly accessibilityLabel: string;
  readonly presentation: ComposerSendPresentation;
  readonly disabled: boolean;
  readonly onSend: (followUp?: ActiveTurnComposerAction) => void;
}) {
  const { presentation } = props;
  const button = (
    <ComposerActionButton
      accessibilityLabel={props.accessibilityLabel}
      icon={presentation.icon}
      variant="primary"
      disabled={props.disabled}
      onPress={() => props.onSend()}
    />
  );
  if (!presentation.offersFollowUpChoice || presentation.action === null || props.disabled) {
    return button;
  }
  const actions = [presentation.action, presentation.alternate].filter(
    (action): action is ActiveTurnComposerAction => action !== null,
  );
  return (
    <Menu
      accessibilityLabel="Choose how to send this message"
      shouldOpenOnLongPress
      actions={actions.map((action) => ({
        id: action,
        title: FOLLOW_UP_ACTION_LABEL[action],
        subtitle: FOLLOW_UP_ACTION_SUBTITLE[action],
        state: action === presentation.action ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) =>
        props.onSend(nativeEvent.event as ActiveTurnComposerAction)
      }
    >
      {button}
    </Menu>
  );
}

export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  readonly animateLayout?: boolean;
}) {
  const colors = useUniwindTheme();
  const targetBorderRadius =
    typeof props.style.borderRadius === "number" ? props.style.borderRadius : 0;
  const animatedBorderRadius = useSharedValue(targetBorderRadius);
  const shouldAnimate = props.animateLayout !== false && Platform.OS !== "android";
  useLayoutEffect(() => {
    animatedBorderRadius.value = shouldAnimate
      ? withTiming(targetBorderRadius, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : targetBorderRadius;
  }, [animatedBorderRadius, shouldAnimate, targetBorderRadius]);
  const animatedShapeStyle = useAnimatedStyle(() => ({
    borderRadius: animatedBorderRadius.value,
  }));
  const layoutTransition = shouldAnimate ? COMPOSER_LAYOUT_TRANSITION : undefined;

  // Each native frame follows the same transition. Animating only the outer
  // clip leaves the glass and content at their final height on the first frame.
  return (
    <Animated.View
      className={
        Platform.OS === "android" ? undefined : "shadow-[0_6px_28px] shadow-adaptive-black-a15-a35"
      }
      layout={layoutTransition}
      style={[
        animatedShapeStyle,
        {
          overflow: "hidden",
        },
      ]}
    >
      <AnimatedGlassSurface
        chrome="none"
        fallbackColor={colors["--color-composer-surface"]}
        fallbackClassName="border border-composer-border"
        glassEffectStyle="regular"
        pointerEvents="none"
        tintColor="transparent"
        layout={layoutTransition}
        style={[{ position: "absolute", inset: 0 }, animatedShapeStyle]}
      >
        {null}
      </AnimatedGlassSurface>
      <Animated.View
        collapsable={false}
        layout={layoutTransition}
        style={[props.style, animatedShapeStyle]}
      >
        {props.children}
      </Animated.View>
    </Animated.View>
  );
}

export const ThreadComposer = function ThreadComposer(props: ThreadComposerProps) {
  const project = useProject(scopeProjectRef(props.environmentId, props.selectedThread.projectId));
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const composerPanel = materialTheme["--color-composer-panel"];
  const navigation = useNavigation();
  const foregroundColor = useUniwindTheme()["--color-foreground"];
  const bodyText = useScaledTextRole("body");
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
  const pendingPastedTextAttachmentCountRef = useRef(0);
  const [pendingPastedTextAttachmentCount, setPendingPastedTextAttachmentCount] = useState(0);
  const settingsSheetPresentation = useThreadSettingsSheetPresentation({
    editorRef: inputRef,
    isEditorFocused: isFocused,
  });
  const settingsRoutePresentation = useExistingThreadSettingsRoutePresentation();
  const settingsRoutePresentedRef = useRef(false);
  const wasExpandedBeforePreviewRef = useRef(false);
  const inFlightThreadIdsRef = useRef(new Set<string>());
  const { onExpandedChange } = props;

  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const composerOwnerKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const composerDraftKey = props.draftKey ?? composerOwnerKey;
  const { text: draftMessage, attachments: draftAttachments } = useComposerDraft(composerDraftKey);
  const queuedEdit = props.queuedEdit ?? null;
  const hasContent =
    draftMessage.trim().length > 0 ||
    draftAttachments.length > 0 ||
    (queuedEdit?.existingAttachments.length ?? 0) > 0;
  const stripAttachments = composerStripAttachments(draftAttachments);
  const showStopAction = !hasContent && props.canStopThread && queuedEdit === null;
  const onResumeQueue = props.onResumeQueue;
  const [resumingQueue, setResumingQueue] = useState(false);
  const showResumeAction =
    !hasContent && !showStopAction && queuedEdit === null && onResumeQueue !== null;
  const handleResumeQueue = async () => {
    if (resumingQueue || onResumeQueue === null) return;
    setResumingQueue(true);
    await onResumeQueue();
    setResumingQueue(false);
  };

  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const attachmentsUploading =
    props.connectionState === "connected" &&
    composerAttachmentsStillUploading({
      environmentId: props.environmentId,
      attachments: draftAttachments,
      serverConfig: props.serverConfig,
      states: uploadStates,
    });
  const sendPresentation = resolveComposerSendPresentation({
    editingQueuedMessage: queuedEdit !== null,
    running: props.activeThreadBusy,
    canSteer: props.canSteerActiveTurn,
    followUpBehavior: props.followUpBehavior,
    deliveryDeferred:
      props.connectionState !== "connected" || props.queueCount > 0 || attachmentsUploading,
  });
  const sendLabel = sendPresentation.label;
  const currentModelSelection = props.selectedThread.modelSelection;
  const currentRuntimeMode = props.selectedThread.runtimeMode;
  const modelUnavailable =
    props.connectionState === "connected" &&
    isModelSelectionUnavailable(
      props.serverConfig,
      currentModelSelection,
      props.selectedThread.projectId,
    );
  const selectedProviderStatus = (() => {
    if (!props.serverConfig) return null;
    return (
      props.serverConfig.providers.find(
        (p) => p.instanceId === props.selectedThread.modelSelection.instanceId,
      ) ?? null
    );
  })();
  const openDraftDocument = (attachment: ComposerDocumentAttachment) => {
    Keyboard.dismiss();
    navigation.navigate("ThreadAttachment", {
      environmentId: String(props.environmentId),
      threadId: String(props.selectedThread.id),
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: String(attachment.sizeBytes),
      draftKey: composerDraftKey,
    });
  };
  const { onSendMessage, onChangeDraftMessage, onShowUsageLimits } = props;
  const usageLimitsOffered =
    selectedProviderStatus !== null &&
    hasProviderUsageLimits(
      selectedProviderStatus.driver,
      props.serverConfig?.providers ?? [],
      props.serverConfig?.usageLimitSources ?? [],
    );
  const openUsageLimits = () => {
    const report = collectProviderUsageLimits(
      currentModelSelection.instanceId,
      props.serverConfig?.providers ?? [],
      props.serverConfig?.usageLimitSources ?? [],
      Date.now(),
    );
    onShowUsageLimits(report);
    if (!report) {
      Dialog.alert("Usage limits unavailable", "This provider does not currently report limits.");
    }
    return report !== null;
  };

  const composerMenu = useComposerCommandMenu({
    draftMessage: draftMessage,
    ownerKey: composerDraftKey,
    environmentId: props.environmentId,
    threadShells: useThreadShells(),
    currentThreadId: props.selectedThread.id,
    projectCwd: props.projectCwd,
    pullRequestProjectId: props.serverConfig?.environment.capabilities.pullRequests
      ? (project?.id ?? null)
      : null,
    pullRequestRepository: project?.repositoryIdentity?.displayName ?? null,
    threadPullRequests: props.selectedThread.pullRequests,
    selectedProviderStatus,
    hasThread: true,
    hasCompactableConversation: props.hasCompactableConversation,
    onChangeDraftMessage: props.onChangeDraftMessage,
    onUpdateInteractionMode:
      selectedProviderStatus?.showInteractionModeToggle === false
        ? undefined
        : props.onUpdateInteractionMode,
    offersUsageLimits: usageLimitsOffered,
    onUsageLimits:
      usageLimitsOffered && draftAttachments.length === 0 ? openUsageLimits : undefined,
  });
  const voiceTarget = { environmentId: props.environmentId, threadId: props.selectedThread.id };
  const voicePhase = useVoiceModePhase(voiceTarget);
  useVoiceModeThreadLifecycle(voiceTarget);
  // Dictation and a voice conversation both need the microphone.
  const voiceConversationLive = voicePhase !== "idle";
  const voiceInput = useVoiceInputController({
    ownerKey: composerDraftKey,
    label: props.selectedThread.title || "Untitled thread",
    readDraftMessage: () => getComposerDraftSnapshot(composerDraftKey).text,
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(composerDraftsAtom, onChange),
    selection: composerMenu.selection,
    disabled: voiceConversationLive,
    onChangeDraftMessage: (text) => setComposerDraftText(composerDraftKey, text),
    onChangeSelection: composerMenu.onSelectionChange,
  });
  const offersVoiceConversation =
    voiceModeSupported &&
    props.serverConfig?.providers.find(
      (provider) => provider.instanceId === props.selectedThread.providerInstanceId,
    )?.supportsVoice === true;
  // The server attaches voice to the thread's provider thread, which the first
  // run creates. An optimistic pending thread already has a message timestamp.
  const canToggleVoiceConversation =
    voiceConversationLive ||
    (props.connectionState === "connected" &&
      props.canOperateThread &&
      props.selectedThread.activeProviderThreadId !== null &&
      !voiceInput.isGloballyBusy);
  const toggleVoiceConversation = () => voiceMode.toggle(voiceTarget);
  const voiceModeButton = offersVoiceConversation ? (
    <ComposerVoiceModeButton
      phase={voicePhase}
      disabled={!canToggleVoiceConversation}
      onPress={toggleVoiceConversation}
    />
  ) : null;
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const isVoiceInputPresented = voicePresentation.statusLabel !== null;
  const isExpanded = isFocused || settingsSheetPresentation.keepsComposerExpanded;
  const showsCompactDictation = isVoiceInputPresented && !isExpanded;
  const isToolbarVisible = isExpanded || isVoiceInputPresented;
  const attachmentBlockReason = composerAttachmentUploadBlockReason({
    environmentId: props.environmentId,
    attachments: draftAttachments,
    connected: props.connectionState === "connected",
    serverConfig: props.serverConfig,
    states: uploadStates,
  });
  const contextImports = useAtomValue(composerContextImportsAtom);
  const sendBlockedReason =
    (queuedEdit?.saving === true ? "Saving…" : null) ??
    props.sendBlockedReason ??
    (pendingPastedTextAttachmentCount > 0 ? "Attaching pasted text" : null) ??
    attachmentBlockReason;
  const canSend =
    (props.canOperateThread || props.connectionState !== "connected") &&
    hasContent &&
    !contextImports[composerDraftKey] &&
    !voiceInput.blocksSubmission &&
    sendBlockedReason === null &&
    !modelUnavailable;

  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  const onPressPreview = (source: FilePreviewSource) => {
    wasExpandedBeforePreviewRef.current = isFocused;
    setPreviewVideo(null);
    setPreviewFile(
      (current) =>
        current ?? {
          ...source,
          gallery: filePreviewGallery(source, composerImageGallery(draftAttachments)),
        },
    );
  };

  const closePreview = () => {
    setPreviewFile(null);
    setPreviewVideo(null);
    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => {
        if (navigation.isFocused()) inputRef.current?.focus();
      }, 100);
    }
  };

  const onPressVideo = (attachment: DraftComposerFileAttachment, sourceIdentifier: string) => {
    wasExpandedBeforePreviewRef.current = isFocused;
    setPreviewFile(null);
    setPreviewVideo((current) => current ?? { type: "local", attachment, sourceIdentifier });
  };

  const onEditorFocusChange = props.onEditorFocusChange;
  const handleFocus = () => {
    setIsFocused(true);
    onExpandedChange?.(true);
    onEditorFocusChange?.(true);
  };

  const handleBlur = () => {
    setIsFocused(false);
    if (!settingsSheetPresentation.keepsComposerExpanded) {
      onExpandedChange?.(false);
    }
    onEditorFocusChange?.(false);
  };
  const handleSend = async (followUp?: ActiveTurnComposerAction) => {
    if (voiceInput.blocksSubmission || pendingPastedTextAttachmentCountRef.current > 0) return;
    if (usageLimitsOffered && isUsageLimitsCommand(draftMessage) && draftAttachments.length === 0) {
      if (openUsageLimits()) onChangeDraftMessage("");
      return;
    }
    const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
    if (inFlightThreadIdsRef.current.has(threadKey)) return;
    inFlightThreadIdsRef.current.add(threadKey);
    const sent = await settlePromise(() => onSendMessage(followUp));
    inFlightThreadIdsRef.current.delete(threadKey);
    if (AsyncResult.isFailure(sent)) {
      // The composer state already surfaces send errors; only the lock needed releasing.
      console.error("[composer] send failed", squashAtomCommandFailure(sent));
      return;
    }
    if (sent.value === null) return;
    // Armed after the send so its preference read and native Activity start don't contend
    // with the queued-message feedback on the tap frame.
    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: props.environmentId,
      threadTitle: props.selectedThread.title,
      projectTitle: props.environmentLabel ?? "T3 Code",
    });
  };

  const lockedProviderInstanceId = props.canSwitchProvider
    ? undefined
    : currentModelSelection.instanceId;
  const modelOptions = buildModelOptions(
    props.serverConfig,
    currentModelSelection,
    lockedProviderInstanceId,
    props.selectedThread.projectId,
  );
  const threadProviderGroups = groupByProvider(modelOptions);
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null;
  const providerOptionDescriptors = resolveProviderOptionDescriptors({
    capabilities: currentModelOption?.capabilities,
    selections: currentModelSelection.options,
  });
  const settingsOwnerId = composerOwnerKey;
  const settingsRouteSession = {
    ownerId: settingsOwnerId,
    environmentId: props.environmentId,
    projectId: props.selectedThread.projectId,
    providerInstanceId: currentModelSelection.instanceId,
    ...(lockedProviderInstanceId ? { lockedProviderInstanceId } : {}),
    providerGroups: threadProviderGroups,
    selectedModel: currentModelSelection,
    reportedModelSelection: props.reportedModelSelection,
    onSelectModel: (option) =>
      props.onUpdateModelSelection(withRememberedModelOptions(option.selection)),
    restoreSelection: withRememberedModelOptions,
    optionDescriptors: providerOptionDescriptors,
    onUpdateOptionSelections: (options) => {
      rememberModelOptions(
        currentModelSelection.instanceId,
        currentModelSelection.model,
        options ?? [],
      );
      props.onUpdateModelSelection({ ...currentModelSelection, options });
    },
    runtimeMode: currentRuntimeMode,
    onUpdateRuntimeMode: props.onUpdateRuntimeMode,
  } satisfies ExistingThreadSettingsRouteSession;
  const openSettings = () => {
    settingsRoutePresentation.present(settingsRouteSession);
    settingsSheetPresentation.open();
  };

  useEffect(() => {
    if (settingsSheetPresentation.isActive) {
      settingsRoutePresentation.present(settingsRouteSession);
    }
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.isActive]);

  useEffect(() => {
    if (!settingsSheetPresentation.isVisible || settingsRoutePresentedRef.current) {
      return;
    }

    settingsRoutePresentedRef.current = true;
    navigation.dispatch(StackActions.push("ThreadSettingsSheet"));
  }, [navigation, settingsSheetPresentation.isVisible]);

  useFocusEffect(() => {
    if (!settingsRoutePresentedRef.current) {
      return;
    }

    settingsRoutePresentedRef.current = false;
    settingsSheetPresentation.onDismissed();
    settingsRoutePresentation.clear(settingsOwnerId);
  });

  useEffect(
    () =>
      // UIKit's completion callback for the sheet dismissal, surfaced by the
      // native-stack patch. This is when the queued keyboard restore runs.
      (navigation as unknown as NavigationWithFinishTransitioning).addListener(
        "finishTransitioning",
        settingsSheetPresentation.onStackTransitionsFinished,
      ),
    [navigation, settingsSheetPresentation.onStackTransitionsFinished],
  );

  return (
    <Animated.View
      className="px-[12px]"
      style={{
        paddingTop: isExpanded ? 8 : 6,
        paddingBottom: (props.bottomInset ?? 0) + (isExpanded ? 8 : 6),
        backgroundColor:
          Platform.OS === "android" ? themeColorWithAlpha(composerPanel, 1) : undefined,
      }}
    >
      {/* The backdrop gradient lives on a plain View: Reanimated's Animated.View
          silently drops experimental_backgroundImage on Android, which left this
          strip fully transparent and the feed text legible through the composer. */}
      <View
        className={
          Platform.OS === "android"
            ? "hidden"
            : "absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        }
        pointerEvents="none"
      />
      <Animated.View
        className="relative w-full self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {!voiceInput.isBusy &&
        composerMenu.trigger &&
        (composerMenu.items.length > 0 || composerMenu.trigger.kind === "pull-request") ? (
          <ComposerPopoverAnchor>
            <ComposerCommandPopover
              items={composerMenu.items}
              triggerKind={composerMenu.trigger.kind}
              isLoading={composerMenu.isLoading}
              error={composerMenu.error}
              onSelect={composerMenu.onSelect}
            />
          </ComposerPopoverAnchor>
        ) : null}

        {selectedProviderStatus?.compatibilityAdvisory?.message &&
        (selectedProviderStatus.compatibilityAdvisory.status === "unsupported" ||
          selectedProviderStatus.compatibilityAdvisory.status === "broken") ? (
          <Text
            accessibilityRole={
              selectedProviderStatus.compatibilityAdvisory.status === "broken" ? "alert" : undefined
            }
            accessibilityLiveRegion={
              selectedProviderStatus.compatibilityAdvisory.status === "broken"
                ? "assertive"
                : "polite"
            }
            className={
              selectedProviderStatus.compatibilityAdvisory.status === "broken"
                ? "bg-danger px-3 py-2 text-xs text-danger-foreground"
                : "px-3 py-2 text-xs text-foreground"
            }
          >
            {selectedProviderStatus.compatibilityAdvisory.message}
          </Text>
        ) : null}

        {voiceConversationLive ? <ComposerVoiceStrip /> : null}

        {modelUnavailable ? (
          <Button
            label="Model unavailable. Open model settings."
            tone="text"
            onPress={openSettings}
          />
        ) : null}

        <ComposerSurface
          style={
            isExpanded
              ? {
                  borderRadius: 26,
                  minHeight: 140,
                  overflow: "hidden" as const,
                  paddingBottom: 6,
                  paddingTop: 14,
                }
              : {
                  borderRadius: 27,
                  overflow: "hidden" as const,
                  paddingVertical: 2,
                }
          }
        >
          <ComposerDictationDraftContent
            className={isExpanded ? undefined : "flex-row items-center"}
            compact={!isExpanded}
            hidden={showsCompactDictation}
          >
            {!isExpanded ? (
              <ComposerAttachmentButton
                supportsFiles={Boolean(
                  props.serverConfig?.environment.capabilities.fileAttachments,
                )}
                onPickMedia={props.onPickDraftMedia}
                onPickFiles={props.onPickDraftFiles}
              />
            ) : null}
            {isExpanded && queuedEdit !== null && queuedEdit.existingAttachments.length > 0 ? (
              <Animated.View
                className="px-[14px] pb-2.5"
                entering={COMPOSER_ATTACHMENT_ENTERING}
                exiting={FadeOut.duration(120)}
              >
                <ComposerQueuedEditAttachments
                  environmentId={props.environmentId}
                  attachments={queuedEdit.existingAttachments}
                  disabled={queuedEdit.saving || voiceInput.isBusy}
                  onRemove={queuedEdit.onRemoveExistingAttachment}
                />
              </Animated.View>
            ) : null}
            {isExpanded && stripAttachments.length > 0 ? (
              <Animated.View
                className="px-[14px] pb-2.5"
                entering={COMPOSER_ATTACHMENT_ENTERING}
                exiting={FadeOut.duration(120)}
              >
                <ComposerAttachmentStrip
                  environmentId={props.environmentId}
                  attachments={stripAttachments}
                  onRemove={voiceInput.isBusy ? () => undefined : props.onRemoveDraftImage}
                  onPressPreview={voiceInput.isBusy ? undefined : onPressPreview}
                  onPressVideo={voiceInput.isBusy ? undefined : onPressVideo}
                  onPressDocument={
                    voiceInput.isBusy
                      ? undefined
                      : (attachment) =>
                          openDraftDocument({
                            attachmentId: attachment.id,
                            name: attachment.name,
                            mimeType: attachment.mimeType,
                            sizeBytes: attachment.sizeBytes,
                          })
                  }
                />
              </Animated.View>
            ) : null}
            <Animated.View
              className={isExpanded ? "px-[14px]" : "min-w-0 flex-1 px-[4px]"}
              layout={COMPOSER_LAYOUT_TRANSITION}
            >
              <ComposerEditor
                hidden={props.hidden}
                draftKey={composerDraftKey}
                environmentId={props.environmentId}
                onOpenMention={(path) => {
                  Keyboard.dismiss();
                  navigation.navigate("ThreadFile", {
                    environmentId: String(props.environmentId),
                    threadId: String(props.selectedThread.id),
                    path: fileRoutePathSegments(path),
                  });
                }}
                onOpenAttachment={openDraftDocument}
                chipsInert={!isExpanded}
                onInertChipPress={() => inputRef.current?.focus()}
                ref={inputRef}
                multiline
                value={draftMessage}
                // The save uses a draft snapshot; further typing would be discarded on success.
                readOnly={voiceInput.freezesEditor || queuedEdit?.saving === true}
                skills={composerMenu.skills}
                selection={composerMenu.selection}
                onChangeText={props.onChangeDraftMessage}
                onSelectionChange={composerMenu.onSelectionChange}
                onPasteImages={(uris) => void props.onNativePasteImages(uris)}
                onPasteText={(paste) => {
                  const insertPaste = () => {
                    const insertion = replaceTextSelection({
                      value: paste.value,
                      selection: paste.selection,
                      text: paste.text,
                    });
                    const selection = { start: insertion.cursor, end: insertion.cursor };
                    props.onChangeDraftMessage(insertion.value);
                    composerMenu.onSelectionChange(selection);
                  };
                  const capabilities = props.serverConfig?.environment.capabilities;
                  const advertisedMax =
                    capabilities?.attachmentUploads === true
                      ? capabilities.fileAttachments?.maxUploadBytes
                      : undefined;
                  const maxBytes =
                    advertisedMax === undefined
                      ? null
                      : clampFileAttachmentUploadBytes(advertisedMax);
                  const wouldExceedInputLimit =
                    paste.value.length -
                      Math.max(0, paste.selection.end - paste.selection.start) +
                      paste.text.length >
                    PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
                  const canAttach =
                    maxBytes !== null &&
                    countComposerDraftAttachmentsAfterSelection(composerDraftKey, {
                      text: paste.value,
                      ...paste.selection,
                    }) < PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
                    new TextEncoder().encode(paste.text).byteLength <= maxBytes;
                  if (
                    pastedTextDisposition({
                      text: paste.text,
                      wouldExceedInputLimit,
                      canAttach: true,
                    }) === "attachment"
                  ) {
                    if (canAttach) {
                      pendingPastedTextAttachmentCountRef.current += 1;
                      setPendingPastedTextAttachmentCount(
                        pendingPastedTextAttachmentCountRef.current,
                      );
                      const finishAttachment = () => {
                        pendingPastedTextAttachmentCountRef.current = Math.max(
                          0,
                          pendingPastedTextAttachmentCountRef.current - 1,
                        );
                        setPendingPastedTextAttachmentCount(
                          pendingPastedTextAttachmentCountRef.current,
                        );
                      };
                      void props.onNativePasteText(paste).then(finishAttachment, finishAttachment);
                    } else if (!wouldExceedInputLimit) {
                      insertPaste();
                    } else {
                      Dialog.alert(
                        wouldExceedInputLimit
                          ? "Pasted text is too large for this message"
                          : "Could not attach pasted text",
                        wouldExceedInputLimit
                          ? "Remove some text or an attachment, then paste again."
                          : "Remove an attachment or use a smaller paste, then try again.",
                      );
                    }
                    return;
                  }
                  insertPaste();
                }}
                placeholder={props.placeholder}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onSubmit={(alternate) =>
                  void handleSend(
                    alternate && sendPresentation.alternate !== null
                      ? sendPresentation.alternate
                      : undefined,
                  )
                }
                submitTitle={sendPresentation.label}
                alternateSubmitTitle={
                  sendPresentation.alternate === null
                    ? sendPresentation.label
                    : FOLLOW_UP_ACTION_LABEL[sendPresentation.alternate]
                }
                scrollEnabled={isExpanded}
                singleLineCentered={!isExpanded}
                contentInsetVertical={
                  isExpanded || Platform.OS === "android" ? 0 : collapsedEditorInset(bodyText)
                }
                style={
                  isExpanded
                    ? {
                        minHeight: 72,
                        maxHeight: 160,
                        paddingVertical: 4,
                      }
                    : {
                        height: 36,
                      }
                }
                textStyle={{
                  ...bodyText,
                  color: foregroundColor,
                }}
              />
            </Animated.View>
            {!isExpanded && stripAttachments.length > 0 ? (
              <View className="flex-row gap-1 pl-1">
                {stripAttachments.slice(0, 3).map((attachment) => (
                  <ComposerAttachmentThumbnail
                    environmentId={props.environmentId}
                    key={attachment.id}
                    attachment={attachment}
                    size={30}
                    borderRadius={8}
                    compact
                    onPressPreview={onPressPreview}
                    onPressVideo={onPressVideo}
                  />
                ))}
                {stripAttachments.length > 3 ? (
                  <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                    <Text className="text-foreground-muted text-2xs font-t3-bold">
                      +{stripAttachments.length - 3}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {!isExpanded ? (
              <View className="flex-row items-center">
                {voiceModeButton}
                <ComposerDictationStartAction
                  state={voiceInput.state}
                  isAvailable={voiceInput.isAvailable}
                  disabled={voiceConversationLive}
                  onStart={voiceInput.start}
                  onCancel={voiceInput.cancel}
                />
                {showStopAction ? (
                  <ComposerActionButton
                    accessibilityLabel="Stop agent"
                    icon="stop.fill"
                    variant="danger"
                    disabled={!props.canOperateThread}
                    onPress={props.onStopThread}
                  />
                ) : showResumeAction ? (
                  <ComposerActionButton
                    accessibilityLabel="Resume queue"
                    icon="play"
                    disabled={!props.canOperateThread || resumingQueue}
                    onPress={() => void handleResumeQueue()}
                  />
                ) : (
                  <SendActionButton
                    accessibilityLabel={sendBlockedReason ?? sendLabel}
                    presentation={sendPresentation}
                    disabled={!canSend}
                    onSend={handleSend}
                  />
                )}
              </View>
            ) : null}
            {isExpanded ? <View className="h-1" /> : null}
          </ComposerDictationDraftContent>
          <Animated.View
            accessibilityElementsHidden={!isToolbarVisible}
            collapsable={false}
            importantForAccessibility={isToolbarVisible ? "auto" : "no-hide-descendants"}
            layout={COMPOSER_LAYOUT_TRANSITION}
            pointerEvents={isToolbarVisible ? "auto" : "none"}
            style={
              isExpanded
                ? undefined
                : {
                    position: "absolute",
                    bottom: 2,
                    left: 0,
                    right: 0,
                  }
            }
          >
            <ComposerDictationToolbar
              showsDictation={isVoiceInputPresented}
              visible={isToolbarVisible}
            >
              <ComposerToolbarRow
                paddingBottom={0}
                paddingHorizontal={0}
                paddingTop={0}
                style={{ gap: 0 }}
              >
                <ComposerDictationCancelAction
                  presentation={voicePresentation}
                  onCancel={voiceInput.cancel}
                />
                {isVoiceInputPresented ? (
                  <ComposerDictationStatus
                    audioLevels={voiceInput.audioLevels}
                    elapsedSeconds={voiceInput.elapsedSeconds}
                    phase={voiceInput.state.phase}
                    presentation={voicePresentation}
                    onDismissError={voiceInput.cancel}
                  />
                ) : (
                  <View className="min-w-0 flex-1 flex-row items-center justify-between">
                    <ComposerAttachmentButton
                      supportsFiles={Boolean(
                        props.serverConfig?.environment.capabilities.fileAttachments,
                      )}
                      onPickMedia={props.onPickDraftMedia}
                      onPickFiles={props.onPickDraftFiles}
                    />
                    <View className="min-w-0 shrink">
                      <ComposerInlineControl
                        accessibilityLabel="Model and reasoning settings"
                        emphasized
                        renderIcon={(size) => (
                          <ProviderIcon
                            iconUrl={currentModelOption?.providerIconUrl}
                            provider={currentModelOption?.providerDriver}
                            size={size}
                          />
                        )}
                        label={currentModelOption?.label ?? currentModelSelection.model}
                        maxWidth="100%"
                        onPress={openSettings}
                      />
                    </View>
                  </View>
                )}
                <View className="shrink-0 flex-row items-center">
                  {isVoiceInputPresented ? null : voiceModeButton}
                  <ComposerDictationPrimaryAction
                    state={voiceInput.state}
                    presentation={voicePresentation}
                    isAvailable={voiceInput.isAvailable}
                    disabled={voiceConversationLive}
                    onStart={voiceInput.start}
                    onConfirm={voiceInput.stop}
                    onCancel={voiceInput.cancel}
                  />
                  {showStopAction ? (
                    <ComposerActionButton
                      accessibilityLabel="Stop agent"
                      icon="stop.fill"
                      variant="danger"
                      disabled={!props.canOperateThread}
                      onPress={props.onStopThread}
                    />
                  ) : showResumeAction && voicePresentation.showsSend ? (
                    <ComposerActionButton
                      accessibilityLabel="Resume queue"
                      icon="play"
                      disabled={!props.canOperateThread || resumingQueue}
                      onPress={() => void handleResumeQueue()}
                    />
                  ) : voicePresentation.showsSend ? (
                    <SendActionButton
                      accessibilityLabel={sendBlockedReason ?? sendLabel}
                      presentation={sendPresentation}
                      disabled={!canSend}
                      onSend={handleSend}
                    />
                  ) : null}
                </View>
              </ComposerToolbarRow>
            </ComposerDictationToolbar>
          </Animated.View>
        </ComposerSurface>

        {props.connectionState === "connected" && !props.canOperateThread ? (
          <Text className="pt-2 text-xs text-foreground-muted">
            This connection cannot control this task. You can still edit your draft.
          </Text>
        ) : null}
      </Animated.View>

      <VideoPreviewModal source={previewVideo} onRequestClose={closePreview} />
      <FilePreviewModal source={previewFile} onRequestClose={closePreview} />
    </Animated.View>
  );
};
