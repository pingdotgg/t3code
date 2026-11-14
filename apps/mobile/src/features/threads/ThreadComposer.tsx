import { COMPOSER_TRANSITION_DURATION_MS } from "./composerTransition.ts";
export { COMPOSER_TRANSITION_DURATION_MS } from "./composerTransition.ts";
import { useThreadComposerController } from "./useThreadComposerController.tsx";
import { useSidebarWorkspaceTabs } from "../workspace/useSystemWorkspaceTabBar";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import type { ComposerTextPaste } from "../../native/T3ComposerEditor.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  useAppearancePreferences,
  useAndroidFloatingTabs,
} from "../settings/appearance/AppearancePreferencesProvider";
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
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { I18nManager, Keyboard, Platform, View, type ViewStyle } from "react-native";
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
  useDerivedValue,
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
import { useProject, useVisibleThreadShells } from "../../state/entities";
import { useMentionableEnvironments } from "../../state/environments";
import { useLinkedEnvironments } from "../../state/peerLinks";
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
import { ComposerActionButton, ComposerToolbarRow } from "../../components/ComposerToolbar";
import { ComposerModelControl } from "../../components/ComposerModelControl";
import {
  composerStripAttachments,
  type DraftComposerFileAttachment,
} from "../../lib/composerImages";
import { buildModelOptions, isModelSelectionUnavailable } from "../../lib/modelOptions";
import { useScaledTextRole, type ScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { Menu } from "../../components/ui/Menu";
import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";
import type { FollowUpBehavior } from "../../lib/followUpBehavior";
import {
  resolveComposerSendPresentation,
  type ComposerSendPresentation,
} from "./composerSendPresentation";
import { compactEditorInsets } from "./compactEditorInsets";
import { ComposerCommandPopover } from "./ComposerCommandPopover";
import { ComposerPopoverAnchor } from "./ComposerPopoverAnchor";
import { ComposerQueuedEditAttachments } from "./ComposerQueuedEdit";
import { useComposerCommandMenu } from "./use-composer-command-menu";
import type { ComposerEnvironmentCandidate } from "@t3tools/client-runtime/composerThreadItems";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import {
  ComposerDictationCancelAction,
  ComposerDictationDraftContent,
  ComposerDictationError,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import type { ExistingThreadSettingsRouteParams } from "./ThreadSettingsSheet";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";
import { useCompactComposerEditor } from "./ThreadComposerParts";
import { ComposerSurface } from "./ThreadComposerParts2";

export const COMPOSER_COLLAPSED_CHROME = 60;

const NO_MACHINES: ReadonlyArray<ComposerEnvironmentCandidate> = [];
export const COLLAPSED_EDITOR_DEFAULT_INSET = 6;
// iOS puts line-height slack above glyphs. DM Sans's lowercase midline is
// descender (0.31em) + half x-height (0.504em) above the line bottom.
const LOWERCASE_MIDLINE_EM = 0.562;

function lowercaseMidline(text: ScaledTextRole): number {
  return text.lineHeight - LOWERCASE_MIDLINE_EM * text.fontSize;
}

export function collapsedEditorInset(text: ScaledTextRole): number {
  const shift = lowercaseMidline(text) - lowercaseMidline(MOBILE_TYPOGRAPHY.body);
  return Math.max(0, Math.round(COLLAPSED_EDITOR_DEFAULT_INSET - shift));
}

export interface ThreadComposerProps {
  readonly isDraft?: boolean;
  readonly canOperateThread: boolean;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly draftControls?: ReactNode;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly environmentLabel: string | null;
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
  readonly interactionLocked?: boolean;
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
  /** `stillSendable` reports whether the draft is unchanged after any wait before sending. */
  readonly onSendMessage: (
    followUp?: ActiveTurnComposerAction,
    stillSendable?: () => boolean,
  ) => Promise<MessageId | null>;
  readonly onShowUsageLimits: (report: UsageLimitsReport | null) => void;
  readonly canSwitchProvider: boolean;
  readonly onUpdateInteractionMode?: (interactionMode: ProviderInteractionMode) => void;
  readonly onHeightChange?: (height: number) => void;
  readonly onEditorFocusChange?: (focused: boolean) => void;
}

// Android KeyboardStickyView tracks the IME; concurrent timed layout morphs cause jitter.
// Side panes animate dock width; nested horizontal transitions would make the surface trail the toolbar.
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
export const COMPOSER_LAYOUT_TRANSITION = Platform.OS === "android" ? undefined : composerHeightTransition;
// Share of the one-row composer the draft keeps; a long model name truncates first.
const INLINE_EDITOR_MIN_WIDTH = "40%";
export const INLINE_EDITOR_HEIGHT = 36;


export const AnimatedGlassSurface = Animated.createAnimatedComponent(GlassSurface);

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
  readonly size?: "regular" | "large";
  readonly accessibilityLabel: string;
  readonly presentation: ComposerSendPresentation;
  readonly disabled: boolean;
  readonly onSend: (followUp?: ActiveTurnComposerAction) => void;
}) {
  const { presentation } = props;
  const button = (
    <ComposerActionButton
      accessibilityLabel={props.accessibilityLabel}
      size={props.size}
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

export const THREAD_COMPOSER_BOTTOM_GUTTER = 6;
export const ThreadComposer = function ThreadComposer(props: ThreadComposerProps) {
  const {
    layout,
    onChangeDraftMessage,
    draftMessage,
    composerPanel,
    navigation,
    foregroundColor,
    bodyText,
    inputRef,
    pendingPastedTextAttachmentCountRef,
    pendingNativeImagePasteCountRef,
    setPendingPastedTextAttachmentCount,
    previewFile,
    previewVideo,
    composerDraftKey,
    stripAttachments,
    showStopAction,
    resumingQueue,
    showResumeAction,
    handleResumeQueue,
    sendPresentation,
    sendLabel,
    modelUnavailable,
    selectedProviderStatus,
    openDraftDocument,
    composerMenu,
    voiceInput,
    isSubmissionLocked,
    voicePresentation,
    isVoiceInputPresented,
    isExpanded,
    usesLargeControls,
    surfacePaddingVertical,
    setCompactRowWidth,
    compactAttachmentLimit,
    compactEditor,
    showsCompactDictation,
    isToolbarVisible,
    sendBlockedReason,
    canSend,
    onPressPreview,
    closePreview,
    onPressVideo,
    handleFocus,
    handleBlur,
    handleSend,
    openSettings,
    editingAttachments,
    modelControl,
  } = useThreadComposerController(props);

  return (
    <Animated.View
      onLayout={(event) => props.onHeightChange?.(event.nativeEvent.layout.height)}
      className="px-[12px]"
      style={{
        paddingTop: 6,
        paddingBottom: (props.bottomInset ?? 0) + THREAD_COMPOSER_BOTTOM_GUTTER,
        backgroundColor:
          Platform.OS === "android" ? themeColorWithAlpha(composerPanel, 1) : undefined,
      }}
    >
      {/* Use a plain View: Reanimated Animated.View drops experimental_backgroundImage on Android. */}
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
        {props.draftControls}
        {!isSubmissionLocked &&
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
        {modelUnavailable ? (
          <Button
            label="Model unavailable. Open model settings."
            tone="text"
            onPress={openSettings}
          />
        ) : null}

        <ComposerSurface
          animateLayout={false}
          style={{
            borderRadius: usesLargeControls ? 31 : 27,
            borderCurve: "circular",
            overflow: "hidden",
            paddingVertical: surfacePaddingVertical,
          }}
        >
          <ComposerDictationError
            error={voiceInput.state.phase === "error" ? voiceInput.state.error : null}
            onDismiss={voiceInput.cancel}
          />
          {isExpanded ? editingAttachments : null}
          <View
            onLayout={(event) => {
              compactEditor.onRowLayout(event);
              setCompactRowWidth(event.nativeEvent.layout.width);
            }}
          >
            <ComposerDictationDraftContent
              className="flex-row items-end"
              compact
              hidden={showsCompactDictation}
            >
              <ComposerAttachmentButton
                size={usesLargeControls ? "large" : "regular"}
                disabled={isSubmissionLocked}
                supportsFiles={props.serverConfig !== null}
                onPickMedia={props.onPickDraftMedia}
                onPickFiles={props.onPickDraftFiles}
              />
              <Animated.View
                className="min-w-0 flex-1"
                onLayout={compactEditor.onEditorLayout}
                style={[
                  {
                    minWidth:
                      compactEditor.isExpanded || stripAttachments.length > 0
                        ? 0
                        : INLINE_EDITOR_MIN_WIDTH,
                  },
                  compactEditor.containerStyle,
                  compactEditor.isExpanded ? { flex: 0, width: 0 } : undefined,
                ]}
              ></Animated.View>
              {/* TalkBack orders siblings by position; outside this row the editor reads after Send. */}
              <Animated.View
                style={[
                  compactEditor.editorStyle,
                  showsCompactDictation ? { display: "none" } : undefined,
                ]}
              >
                <ComposerEditor
                  hidden={props.hidden}
                  draftKey={composerDraftKey}
                  environmentId={props.environmentId}
                  onOpenMention={(path) => {
                    Keyboard.dismiss();
                    if (props.isDraft) {
                      navigation.navigate("NewTaskFile", {
                        environmentId: String(props.environmentId),
                        cwd: props.projectCwd ?? undefined,
                        path: fileRoutePathSegments(path),
                      });
                    } else {
                      navigation.navigate("ThreadFile", {
                        environmentId: String(props.environmentId),
                        threadId: String(props.selectedThread.id),
                        path: fileRoutePathSegments(path),
                      });
                    }
                  }}
                  onOpenAttachment={openDraftDocument}
                  chipsInert={!isExpanded}
                  onInertChipPress={() => inputRef.current?.focus()}
                  ref={inputRef}
                  multiline
                  value={draftMessage}
                  // The save uses a draft snapshot; further typing would be discarded on success.
                  readOnly={isSubmissionLocked}
                  skills={composerMenu.skills}
                  selection={composerMenu.selection}
                  onChangeText={(text) => {
                    if (!isSubmissionLocked) props.onChangeDraftMessage(text);
                  }}
                  onSelectionChange={composerMenu.onSelectionChange}
                  onPasteImages={(uris) => {
                    if (isSubmissionLocked) return;
                    pendingNativeImagePasteCountRef.current += 1;
                    void props.onNativePasteImages(uris).finally(() => {
                      pendingNativeImagePasteCountRef.current -= 1;
                    });
                  }}
                  onPasteText={(paste) => {
                    if (isSubmissionLocked) return;
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
                    const advertisedMax = capabilities?.fileAttachments?.maxUploadBytes;
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
                        void props
                          .onNativePasteText(paste)
                          .then(finishAttachment, finishAttachment);
                      } else if (!wouldExceedInputLimit) {
                        insertPaste();
                      } else {
                        Dialog.alert(
                          "Pasted text is too large for this message",
                          "Remove some text or an attachment, then paste again.",
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
                  {...compactEditor.editorProps}
                  textStyle={{
                    ...bodyText,
                    color: foregroundColor,
                  }}
                />
              </Animated.View>
              {!isExpanded && stripAttachments.length > 0 ? (
                <View className="h-[44px] shrink-0 flex-row items-center gap-1 pl-1">
                  {stripAttachments.slice(0, compactAttachmentLimit).map((attachment) => (
                    <ComposerAttachmentThumbnail
                      environmentId={props.environmentId}
                      key={attachment.id}
                      attachment={attachment}
                      size={30}
                      borderRadius={8}
                      compact
                      onPressPreview={isSubmissionLocked ? undefined : onPressPreview}
                      onPressVideo={isSubmissionLocked ? undefined : onPressVideo}
                    />
                  ))}
                  {stripAttachments.length > compactAttachmentLimit ? (
                    <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                      <Text className="text-foreground-muted text-2xs font-t3-bold">
                        +{stripAttachments.length - compactAttachmentLimit}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
              <View
                className="min-w-0 shrink flex-row items-center"
                style={
                  compactEditor.isExpanded ? { flex: 1, justifyContent: "flex-end" } : undefined
                }
              >
                {modelControl}
                <ComposerDictationStartAction
                  size={usesLargeControls ? "large" : "regular"}
                  state={voiceInput.state}
                  isAvailable={voiceInput.isAvailable}
                  disabled={isSubmissionLocked}
                  onStart={voiceInput.start}
                  onCancel={voiceInput.cancel}
                />
                {showStopAction ? (
                  <ComposerActionButton
                    size={usesLargeControls ? "large" : "regular"}
                    accessibilityLabel="Stop agent"
                    icon="stop.fill"
                    variant="danger"
                    disabled={!props.canOperateThread}
                    onPress={props.onStopThread}
                  />
                ) : showResumeAction ? (
                  <ComposerActionButton
                    size={usesLargeControls ? "large" : "regular"}
                    accessibilityLabel="Resume thread"
                    icon="play"
                    disabled={!props.canOperateThread || resumingQueue}
                    onPress={() => void handleResumeQueue()}
                  />
                ) : (
                  <SendActionButton
                    size={usesLargeControls ? "large" : "regular"}
                    accessibilityLabel={sendBlockedReason ?? sendLabel}
                    presentation={sendPresentation}
                    disabled={!canSend}
                    onSend={handleSend}
                  />
                )}
              </View>
            </ComposerDictationDraftContent>
          </View>
          <Animated.View
            accessibilityElementsHidden={!isToolbarVisible}
            collapsable={false}
            importantForAccessibility={isToolbarVisible ? "auto" : "no-hide-descendants"}
            pointerEvents={isToolbarVisible ? "auto" : "none"}
            style={{ position: "absolute", bottom: surfacePaddingVertical, left: 0, right: 0 }}
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
                  size={usesLargeControls ? "large" : "regular"}
                  presentation={voicePresentation}
                  onCancel={voiceInput.cancel}
                />
                <ComposerDictationStatus
                  audioLevels={voiceInput.audioLevels}
                  elapsedSeconds={voiceInput.elapsedSeconds}
                  phase={voiceInput.state.phase}
                  presentation={voicePresentation}
                />
                <View className="shrink-0 flex-row items-center">
                  <ComposerDictationPrimaryAction
                    size={usesLargeControls ? "large" : "regular"}
                    state={voiceInput.state}
                    presentation={voicePresentation}
                    isAvailable={voiceInput.isAvailable}
                    disabled={isSubmissionLocked}
                    onStart={voiceInput.start}
                    onConfirm={voiceInput.stop}
                    onCancel={voiceInput.cancel}
                  />
                  {showStopAction ? (
                    <ComposerActionButton
                      size={usesLargeControls ? "large" : "regular"}
                      accessibilityLabel="Stop agent"
                      icon="stop.fill"
                      variant="danger"
                      disabled={!props.canOperateThread}
                      onPress={props.onStopThread}
                    />
                  ) : showResumeAction && voicePresentation.showsSend ? (
                    <ComposerActionButton
                      size={usesLargeControls ? "large" : "regular"}
                      accessibilityLabel="Resume thread"
                      icon="play"
                      disabled={!props.canOperateThread || resumingQueue}
                      onPress={() => void handleResumeQueue()}
                    />
                  ) : voicePresentation.showsSend ? (
                    <SendActionButton
                      size={usesLargeControls ? "large" : "regular"}
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
