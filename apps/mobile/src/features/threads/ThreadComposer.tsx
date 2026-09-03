import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationThreadShell,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ActivityIndicator, Platform, Pressable, View, type ViewStyle } from "react-native";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "../../state/composer-attachment-uploads";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutDown,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { scopedThreadKey } from "../../lib/scopedEntities";

import { AppText as Text } from "../../components/AppText";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import {
  ComposerAttachmentStrip,
  ComposerAttachmentThumbnail,
} from "../../components/ComposerAttachmentStrip";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { GlassSurface } from "../../components/GlassSurface";
import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarRow,
} from "../../components/ComposerToolbar";
import { ProviderIcon } from "../../components/ProviderIcon";
import type {
  DraftComposerAttachment,
  DraftComposerFileAttachment,
} from "../../lib/composerImages";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { ComposerCommandPopover } from "./ComposerCommandPopover";
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
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "./ThreadSettingsSheet";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";

/**
 * Height of the collapsed composer (pill + vertical padding, excluding safe-area inset).
 * Exported so the parent can compute feed overlap / content insets.
 */
export const COMPOSER_COLLAPSED_CHROME = 60;

/**
 * Height of the expanded composer (card + toolbar + vertical padding, excluding safe-area inset).
 * Used by the parent to compute the larger feed bottom inset when the composer is focused.
 */
export const COMPOSER_EXPANDED_CHROME = 156;

export interface ThreadComposerProps {
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerAttachment>;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  /**
   * Message sync phase for the selected thread (drives the status pill):
   * "loading" = first fetch, nothing to show yet; "syncing" = cached messages
   * are on screen while they reconcile with the server.
   */
  readonly threadSyncPhase?: "loading" | "syncing" | null;
  readonly selectedThread: OrchestrationThreadShell;
  readonly serverConfig: T3ServerConfig | null;
  readonly queueCount: number;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string | null;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: () => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: () => Promise<MessageId | null>;
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onReconnectEnvironment: () => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
  /** Fires on editor focus/blur; hosts use it to vet stale keyboard state. */
  readonly onEditorFocusChange?: (focused: boolean) => void;
}

/**
 * The pill / card container — renders with Expo's native GlassView on supported
 * iOS 26+ devices and keeps the existing opaque fallback elsewhere.
 * Exported so NewTaskDraftScreen can render the same composer chrome.
 */
// The bottom-anchored dock position and clipped surface height use the same
// transition so the card grows upward without exposing its final-size content.
// Android gets NO layout transition: the composer rides the keyboard via
// KeyboardStickyView (frame-synced to the IME), and a time-based morph
// running alongside that translate reads as jitter. Snapping the layout and
// letting the keyboard-synced slide be the only motion looks native there.
export const COMPOSER_TRANSITION_DURATION_MS = 220;
export const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === "android"
    ? undefined
    : LinearTransition.duration(COMPOSER_TRANSITION_DURATION_MS).reduceMotion(ReduceMotion.System);

const COMPOSER_ATTACHMENT_ENTERING =
  Platform.OS === "android"
    ? FadeIn.duration(160)
    : FadeIn.delay(COMPOSER_TRANSITION_DURATION_MS).duration(160).reduceMotion(ReduceMotion.System);

const AnimatedGlassSurface = Animated.createAnimatedComponent(GlassSurface);

export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  /** Morphs between the compact and expanded composer layouts. */
  readonly animateLayout?: boolean;
}) {
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
      className="shadow-[0_6px_28px] shadow-adaptive-black-a15-a35"
      layout={layoutTransition}
      style={[
        animatedShapeStyle,
        {
          overflow: "hidden",
          // Android versions before 9 do not support outset box shadows.
          elevation: Platform.OS === "android" && Platform.Version < 28 ? 10 : undefined,
        },
      ]}
    >
      <AnimatedGlassSurface
        chrome="none"
        fallbackClassName="border border-border bg-card-translucent"
        glassEffectStyle="regular"
        // The composer is a passive material containing interactive controls.
        // Keep native glass out of the interactive content's layout path.
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

type ComposerStatusPillState = {
  readonly kind: "unavailable" | "reconnecting" | "syncing";
  readonly label: string;
};

function composerConnectionStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: RemoteClientConnectionState;
  readonly environmentLabel: string | null;
  readonly threadSyncPhase?: "loading" | "syncing" | null;
}): ComposerStatusPillState | null {
  const environmentLabel = input.environmentLabel ?? "Environment";

  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "reconnecting",
        label:
          input.connectionError === null
            ? `Reconnecting to ${environmentLabel}...`
            : `Failed to connect. Retrying ${environmentLabel}...`,
      };
    case "offline":
      return { kind: "unavailable", label: "You are offline" };
    case "error":
      return {
        kind: "unavailable",
        label: input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      };
    case "available":
      return { kind: "unavailable", label: `${environmentLabel} is not connected` };
    case "connected":
      break;
  }

  // Connected: the pill is the single loading/sync indicator. One stable
  // label per open — "Loading" when starting from scratch, "Syncing" when
  // cached messages are already visible.
  switch (input.threadSyncPhase) {
    case "loading":
      return { kind: "syncing", label: "Loading messages..." };
    case "syncing":
      return { kind: "syncing", label: "Syncing messages..." };
    default:
      return null;
  }
}

const ComposerConnectionStatusPill = memo(function ComposerConnectionStatusPill(props: {
  readonly onPress: () => void;
  readonly status: ComposerStatusPillState;
}) {
  const isReconnecting = props.status.kind !== "unavailable";
  return (
    <Animated.View
      className="absolute inset-x-0 bottom-full items-center pb-2"
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(140)}
      pointerEvents="box-none"
    >
      <Pressable
        accessibilityRole="button"
        onPress={props.onPress}
        className="max-w-full flex-row items-center gap-2 rounded-full bg-card px-3 py-2 shadow-sm active:opacity-70"
      >
        {isReconnecting ? (
          <ActivityIndicator size="small" colorClassName={"accent-icon-muted"} />
        ) : (
          <View className="h-2 w-2 rounded-full bg-red-500" />
        )}
        <Text
          className="max-w-[260px] text-sm font-t3-bold leading-snug text-foreground"
          numberOfLines={1}
        >
          {props.status.label}
        </Text>
      </Pressable>
    </Animated.View>
  );
});

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps) {
  const navigation = useNavigation();
  const foregroundColor = useUniwindTheme()["--color-foreground"];
  const bodyText = useScaledTextRole("body");
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
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
  const hasContent = props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0;
  const showStopAction =
    !hasContent &&
    (props.selectedThread.session?.status === "running" ||
      props.selectedThread.session?.status === "starting");

  const sendLabel =
    props.connectionState !== "connected" || props.queueCount > 0 ? "Queue" : "Send";
  const currentModelSelection = props.selectedThread.modelSelection;
  const currentRuntimeMode = props.selectedThread.runtimeMode;
  const connectionStatus = composerConnectionStatus({
    connectionError: props.connectionError,
    connectionState: props.connectionState,
    environmentLabel: props.environmentLabel,
    threadSyncPhase: props.threadSyncPhase,
  });
  const selectedProviderStatus = useMemo(() => {
    if (!props.serverConfig) return null;
    return (
      props.serverConfig.providers.find(
        (p) => p.instanceId === props.selectedThread.modelSelection.instanceId,
      ) ?? null
    );
  }, [props.serverConfig, props.selectedThread.modelSelection.instanceId]);
  const composerOwnerKey = scopedThreadKey(props.environmentId, props.selectedThread.id);

  const composerMenu = useComposerCommandMenu({
    draftMessage: props.draftMessage,
    ownerKey: composerOwnerKey,
    environmentId: props.environmentId,
    projectCwd: props.projectCwd,
    selectedProviderStatus,
    hasThread: true,
    onChangeDraftMessage: props.onChangeDraftMessage,
    onUpdateInteractionMode: props.onUpdateInteractionMode,
  });
  const voiceInput = useVoiceInputController({
    ownerKey: composerOwnerKey,
    draftMessage: props.draftMessage,
    selection: composerMenu.selection,
    onChangeDraftMessage: props.onChangeDraftMessage,
    onChangeSelection: composerMenu.onSelectionChange,
  });
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const isVoiceInputPresented = voicePresentation.statusLabel !== null;
  // An open draft stays visible; only a collapsed composer becomes a voice strip.
  const isExpanded = isFocused || settingsSheetPresentation.isActive;
  const showsCompactDictation = isVoiceInputPresented && !isExpanded;
  const isToolbarVisible = isExpanded || isVoiceInputPresented;
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const attachmentBlockReason = composerAttachmentUploadBlockReason({
    environmentId: props.environmentId,
    attachments: props.draftAttachments,
    connected: props.connectionState === "connected",
    serverConfig: props.serverConfig,
    states: uploadStates,
  });
  const canSend = hasContent && !voiceInput.blocksSubmission && attachmentBlockReason === null;

  // Keep the feed inset aligned with the card or compact dictation strip.
  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  const onPressPreview = useCallback(
    (source: FilePreviewSource) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewVideo(null);
      setPreviewFile((current) => current ?? source);
    },
    [isFocused],
  );

  const closePreview = useCallback(() => {
    setPreviewFile(null);
    setPreviewVideo(null);
    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => {
        if (navigation.isFocused()) inputRef.current?.focus();
      }, 100);
    }
  }, [inputRef, navigation]);

  const onPressVideo = useCallback(
    (attachment: DraftComposerFileAttachment, sourceIdentifier: string) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewFile(null);
      setPreviewVideo((current) => current ?? { type: "local", attachment, sourceIdentifier });
    },
    [isFocused],
  );

  const onEditorFocusChange = props.onEditorFocusChange;
  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onExpandedChange?.(true);
    onEditorFocusChange?.(true);
  }, [onEditorFocusChange, onExpandedChange]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    if (!settingsSheetPresentation.isActive) {
      onExpandedChange?.(false);
    }
    onEditorFocusChange?.(false);
  }, [onEditorFocusChange, onExpandedChange, settingsSheetPresentation.isActive]);
  const { onSendMessage } = props;

  const handleSend = useCallback(async () => {
    if (voiceInput.blocksSubmission) return;
    const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
    if (inFlightThreadIdsRef.current.has(threadKey)) return;
    inFlightThreadIdsRef.current.add(threadKey);
    try {
      const messageId = await onSendMessage();
      if (messageId === null) {
        return;
      }
      // Sending a prompt starts agent work: arm the lock-screen card while the
      // app is foregrounded and the activity token can be registered. Armed
      // after the send so its preference read and native Activity start don't
      // contend with the queued-message feedback on the tap frame.
      armAgentAwarenessLiveActivityForLocalWork({
        environmentId: props.environmentId,
        threadTitle: props.selectedThread.title,
        projectTitle: props.environmentLabel ?? "T3 Code",
      });
    } finally {
      inFlightThreadIdsRef.current.delete(threadKey);
    }
  }, [
    onSendMessage,
    props.environmentId,
    props.environmentLabel,
    props.selectedThread.id,
    props.selectedThread.title,
    voiceInput.blocksSubmission,
  ]);

  // ── Model menu ───────────────────────────────────────────
  const modelOptions = useMemo(
    () => buildModelOptions(props.serverConfig, currentModelSelection),
    [props.serverConfig, currentModelSelection],
  );
  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  // An existing thread is bound to its harness: sessions can't move between
  // provider instances, so the picker only offers the thread's own group.
  const threadProviderGroups = useMemo(
    () => providerGroups.filter((group) => group.providerKey === currentModelSelection.instanceId),
    [providerGroups, currentModelSelection.instanceId],
  );
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null;
  const providerOptionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: currentModelSelection.options,
      }),
    [currentModelOption?.capabilities, currentModelSelection.options],
  );
  const settingsOwnerId = composerOwnerKey;
  const settingsRouteSession = useMemo<ExistingThreadSettingsRouteSession>(
    () => ({
      ownerId: settingsOwnerId,
      environmentId: props.environmentId,
      providerGroups: threadProviderGroups,
      selectedModel: currentModelSelection,
      onSelectModel: (option) => props.onUpdateModelSelection(option.selection),
      optionDescriptors: providerOptionDescriptors,
      onUpdateOptionSelections: (options) =>
        props.onUpdateModelSelection({ ...currentModelSelection, options }),
      runtimeMode: currentRuntimeMode,
      onUpdateRuntimeMode: props.onUpdateRuntimeMode,
    }),
    [
      currentModelSelection,
      currentRuntimeMode,
      props.onUpdateModelSelection,
      props.onUpdateRuntimeMode,
      providerOptionDescriptors,
      settingsOwnerId,
      threadProviderGroups,
    ],
  );
  const openSettings = useCallback(() => {
    settingsRoutePresentation.present(settingsRouteSession);
    settingsSheetPresentation.open();
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.open]);

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

  useFocusEffect(
    useCallback(() => {
      if (!settingsRoutePresentedRef.current) {
        return;
      }

      settingsRoutePresentedRef.current = false;
      settingsSheetPresentation.onDismissed();
      settingsRoutePresentation.clear(settingsOwnerId);
    }, [settingsOwnerId, settingsRoutePresentation.clear, settingsSheetPresentation.onDismissed]),
  );

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
      }}
    >
      {/* The backdrop gradient lives on a plain View: Reanimated's Animated.View
          silently drops experimental_backgroundImage on Android, which left this
          strip fully transparent and the feed text legible through the composer. */}
      <View
        className="absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        pointerEvents="none"
      />
      <Animated.View
        className="relative w-full self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {!voiceInput.isBusy && composerMenu.trigger && composerMenu.items.length > 0 ? (
          <View className="absolute inset-x-0 bottom-full z-10 mb-2">
            <ComposerCommandPopover
              items={composerMenu.items}
              triggerKind={composerMenu.trigger.kind}
              isLoading={composerMenu.isLoading}
              onSelect={composerMenu.onSelect}
            />
          </View>
        ) : null}

        {connectionStatus ? (
          <ComposerConnectionStatusPill
            status={connectionStatus}
            onPress={props.onReconnectEnvironment}
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
                  // Keep the numeric radius close to the expanded card so the
                  // shape morph stays bounded while rendering as a capsule.
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
            {isExpanded && props.draftAttachments.length > 0 ? (
              <Animated.View
                className="px-[14px] pb-2.5"
                entering={COMPOSER_ATTACHMENT_ENTERING}
                exiting={FadeOut.duration(120)}
              >
                <ComposerAttachmentStrip
                  environmentId={props.environmentId}
                  attachments={props.draftAttachments}
                  onRemove={voiceInput.isBusy ? () => undefined : props.onRemoveDraftImage}
                  onPressPreview={voiceInput.isBusy ? undefined : onPressPreview}
                  onPressVideo={voiceInput.isBusy ? undefined : onPressVideo}
                />
              </Animated.View>
            ) : null}
            <Animated.View
              className={isExpanded ? "px-[14px]" : "min-w-0 flex-1 px-[4px]"}
              layout={COMPOSER_LAYOUT_TRANSITION}
            >
              <ComposerEditor
                ref={inputRef}
                multiline
                value={props.draftMessage}
                readOnly={voiceInput.freezesEditor}
                skills={composerMenu.skills}
                selection={composerMenu.selection}
                onChangeText={props.onChangeDraftMessage}
                onSelectionChange={composerMenu.onSelectionChange}
                onPasteImages={(uris) => void props.onNativePasteImages(uris)}
                placeholder={props.placeholder}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onSubmit={handleSend}
                scrollEnabled={isExpanded}
                // Android: collapsed single line centers natively (gravity) in
                // a pill-height box matching the send button; iOS keeps insets.
                singleLineCentered={!isExpanded}
                contentInsetVertical={isExpanded || Platform.OS === "android" ? 0 : 6}
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
            {!isExpanded && props.draftAttachments.length > 0 ? (
              <View className="flex-row gap-1 pl-1">
                {props.draftAttachments.slice(0, 3).map((attachment) => (
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
                {props.draftAttachments.length > 3 ? (
                  <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                    <Text className="text-foreground-muted text-2xs font-t3-bold">
                      +{props.draftAttachments.length - 3}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {!isExpanded ? (
              <View className="flex-row items-center">
                <ComposerDictationStartAction
                  state={voiceInput.state}
                  isAvailable={voiceInput.isAvailable}
                  onStart={voiceInput.start}
                  onCancel={voiceInput.cancel}
                />
                {showStopAction ? (
                  <ComposerActionButton
                    accessibilityLabel="Stop agent"
                    icon="stop.fill"
                    variant="danger"
                    onPress={props.onStopThread}
                  />
                ) : (
                  <ComposerActionButton
                    accessibilityLabel={attachmentBlockReason ?? sendLabel}
                    icon="arrow.up"
                    variant="primary"
                    disabled={!canSend}
                    onPress={handleSend}
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
                    <View className="min-w-0 shrink" style={{ maxWidth: 152 }}>
                      <ComposerInlineControl
                        accessibilityLabel="Model and reasoning settings"
                        emphasized
                        iconNode={
                          <ProviderIcon provider={currentModelOption?.providerDriver} size={16} />
                        }
                        label={currentModelOption?.label ?? currentModelSelection.model}
                        maxWidth={152}
                        onPress={openSettings}
                      />
                    </View>
                  </View>
                )}
                <View className="shrink-0 flex-row items-center">
                  <ComposerDictationPrimaryAction
                    state={voiceInput.state}
                    presentation={voicePresentation}
                    isAvailable={voiceInput.isAvailable}
                    onStart={voiceInput.start}
                    onConfirm={voiceInput.stop}
                    onCancel={voiceInput.cancel}
                  />
                  {showStopAction ? (
                    <ComposerActionButton
                      accessibilityLabel="Stop agent"
                      icon="stop.fill"
                      variant="danger"
                      onPress={props.onStopThread}
                    />
                  ) : voicePresentation.showsSend ? (
                    <ComposerActionButton
                      accessibilityLabel={attachmentBlockReason ?? sendLabel}
                      icon="arrow.up"
                      variant="primary"
                      disabled={!canSend}
                      onPress={handleSend}
                    />
                  ) : null}
                </View>
              </ComposerToolbarRow>
            </ComposerDictationToolbar>
          </Animated.View>
        </ComposerSurface>

        {/* Queue count */}
        {props.queueCount > 0 ? (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
            <Text className="pt-2 text-xs text-foreground-muted">
              {props.queueCount} queued message{props.queueCount === 1 ? "" : "s"} will send
              automatically.
            </Text>
          </Animated.View>
        ) : null}
      </Animated.View>

      <VideoPreviewModal source={previewVideo} onRequestClose={closePreview} />
      <FilePreviewModal source={previewFile} onRequestClose={closePreview} />
    </Animated.View>
  );
});
