import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useWorkspaceSettledContentWidth } from "../layout/workspace-content-width";
import { ThreadMarkdownVideo, ThreadMediaVisibleContext } from "./ThreadMarkdownVideo";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import {
  enrichedContextLinkCustomization,
  enrichedThreadLinkCustomization,
  withChipIcon,
} from "../../native/useEnrichedLinkVariants";
import {
  enrichedSkillDisplayName,
  enrichedSkillInstructionsPath,
  enrichedSkillReference,
} from "../../lib/enrichedLinkPresentation";
import { ThreadContextDivider } from "./thread-context-divider";
import {
  ThreadHandoffDivider,
  ThreadHandoffRow,
  ThreadModelSwitchDivider,
} from "./thread-handoff-row";
import { GuestBubbleTint, GuestMessageName } from "./guestMessageStyle";
import { ThreadGuestPendingMessage, useThreadGuestShare } from "./ThreadGuestShareBar";
import { LinkRequestCard } from "./LinkRequestCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import {
  WorktreeWorkingHeader,
  WorktreeSetupCard,
  type WorktreeSetupCardProps,
} from "./worktree-setup-card";
import * as Haptics from "expo-haptics";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { useViewabilityAmount, type LegendListRef } from "@legendapp/list/react-native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { HandoffEndpoints } from "@t3tools/client-runtime/handoff";
import {
  IDLE_COMPACTING_LABELS,
  resolveUserMessageFileCards,
  resolveUserMessagePresentation,
} from "@t3tools/client-runtime/user-message";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { WorkflowOpening } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  AuthFilesystemReadScope,
  idleCompactionOf,
  type OrchestrationMessageContext,
  ThreadId,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type RunId,
  type ScheduledTaskId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import { hostedThreadLink, parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { PROMPT_LINK_MAX_PROMPT_LENGTH } from "@t3tools/shared/promptLinks";
import {
  parseComposerContextHref,
  collectComposerContextReferences,
  replaceComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { ComposerContextSheet } from "../../components/ComposerContextSheet";
import { writeComposerContextClipboard } from "../../lib/composerContextClipboard";
import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
} from "@t3tools/shared/codexArtifactTemplates";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  executeAtomQuery,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import {
  renderCodexInlineDirectivesAsMarkdown,
  splitCodexArtifactTemplateMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useDeviceType } from "../../native/native-layout-metrics";
import { isDuoDevice } from "../../lib/device-type";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useId,
  type ComponentPropsWithRef,
  type ComponentRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import {
  Image,
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  type ColorValue,
  useWindowDimensions,
  View,
} from "react-native";
import { Image as ExpoImage } from "expo-image";
import { useResolveClassNames } from "uniwind";
import { useReduceMotionEnabled } from "../../lib/appState";
import { useFilePreviewGallery, FilePreviewGallery } from "../../components/FilePreviewGallery";
import { assetImageSource } from "../../lib/assetImageSource";
import { composerImageGallery } from "../../lib/composerImageGallery";
import { isFileBackedComposerAttachment } from "../../lib/composerImages";
import { useLocalAttachmentPreview } from "../../lib/localAttachmentPreview";
import { messageImageGallery } from "./messageImageGallery";
import { MARKDOWN_IMAGE_MAX_WIDTH, resolveMarkdownImageDisplaySize } from "./markdownImageSize";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { inlineFilePreviewKind, isPdfFile } from "../../lib/filePreview";
import { ThreadInlineFilePreview } from "./ThreadInlineFilePreview";
import { flattenThemeColor } from "../../lib/mobileTheme";
import { PresentationSource } from "../../components/ui/NativePresentation";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeInDown, type SharedValue } from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { FONT_FAMILIES } from "../../lib/fontFamilies";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { splitMarkdownDetails } from "../../lib/markdownDetails";
import { hasWideMarkdownBlock } from "../../lib/wideMarkdownBlocks";
import {
  SelectableMarkdownText,
  type MarkdownFileContextMenu,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
  type MarkdownLinkCustomization,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";

import { AppText as Text } from "../../components/ui/AppText";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { markdownFileEmbedLabel, resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { attachmentVideoPreviewSource } from "../../lib/videoPreviewSource";
import { CopyTextButton } from "./CopyTextButton";
import { getReviewSectionIdForCheckpoint } from "../review/reviewModel";
import { setReviewSelectedSectionId } from "../review/reviewState";
import { Menu } from "../../components/ui/Menu";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { copyPromptLink } from "../prompt-links/prompt-link-actions";
import { parseReviewCommentMessageSegments } from "../review/reviewCommentSelection";
import {
  ReviewCommentCard,
  useReviewCommentColors,
  type ReviewCommentColors,
} from "../review/ReviewCommentCard";
import { cn } from "../../lib/cn";
import {
  deriveCenteredContentHorizontalPadding,
  deriveThreadFeedInitialContentInset,
  deriveThreadWorkLogSizing,
  type LayoutVariant,
} from "../../lib/layout";
import { uuidv4 } from "../../lib/uuid";
import { resolveNativeMarkdownTypography } from "../../lib/appearancePreferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import {
  normalizeNativeMarkdownUrl,
  resolveMarkdownLinkPresentation,
} from "../../lib/markdownLinks";
import {
  createThreadFeedCache,
  threadFeedCompactionLabels,
  failedFeedRunIds,
  deriveThreadFeedPresentation,
  threadFeedRunIsUnsettled,
  isContextCompactionActivityGroup,
  isContextHandoffActivityGroup,
  isLinkRequestActivityGroup,
  isSecretRequestActivityGroup,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
  messageFoldRunId,
} from "../../lib/threadActivity";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import {
  resolveThreadFeedLiveFollow,
  resolveThreadFeedReflowAnchor,
  resolveThreadFeedReflowOffset,
  resolveThreadFeedReflowScroll,
  type ThreadFeedLiveFollowEvent,
  type ThreadFeedReflowAnchor,
  type ThreadWorkGroupScrollPosition,
} from "./thread-feed-live-follow";
import {
  collapsedWorkLogHeight,
  ThreadDisclosureChevron,
  THREAD_DISCLOSURE_TRANSITION_MS,
  ThreadWorkGroupToggle,
  ThreadThinkingRow,
  ThreadWorkLog,
  WORK_GROUP_TOGGLE_HEIGHT,
} from "./thread-work-log";
import {
  appendGuestPendingMessages,
  appendPendingThreadMessages,
  createThreadFeedGrouping,
  isCompactionCommandFeedEntry,
  type GroupedThreadFeedRow,
  type ThreadFeedRow,
} from "./pending-thread-feed";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { resolveThreadFeedFixedItemSize } from "./thread-feed-item-size";
import { htmlRenderFrameHeight } from "@t3tools/shared/htmlRender";
import { htmlRenderRowHeight, ThreadHtmlRender } from "./HtmlRenderWebView";
import { ThreadMcpApp } from "./McpAppWebView";
import { assetEnvironment, useAssetUrl, useRefreshAssetUrl } from "../../state/assets";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { readEnvironmentScope, usePreparedConnection } from "../../state/session";
import { projectEnvironment } from "../../state/projects";
import {
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import {
  resolveThreadLink,
  useLiveThreadLinkLabels,
  useQuietThreadShell,
  useThreadChipIcons,
} from "../../state/entities";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { composerDocumentAttachmentRecord } from "../../lib/composerContext";
import * as Option from "effect/Option";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { ThreadWorkflowOpening, useWorkflowOpening } from "./thread-workflow-opening";
import { useAtomCommand } from "../../state/use-atom-command";
import { useV2ItemSupport } from "../../state/v2-item-support";
import {
  fileRoutePathSegments,
  resolveFileLinkPath,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";
import { waitForThreadShellReady } from "./threadForkNavigation";
import { resolveUserMessageIntentBadge } from "./userMessageIntentBadge";
import { fileChipClipboardPath, fileChipMenu, resolveFileChipTarget } from "./fileChipMenu";
import { useFileChipShare } from "./useFileChipShare";
import { useOpenLinkedThread } from "./useOpenLinkedThread";
import {
  MarkdownImageAvailableWidthContext,
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";
import { openSettings } from "../settings/settings-navigation";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { MessageAttachmentFile } from "./ThreadFeedParts";

import { useThreadFeedView } from "./thread-feed/use-thread-feed-view.tsx";
import { useThreadFeedMarkdown } from "./thread-feed/use-thread-feed-markdown.tsx";
import { useThreadFeedList } from "./thread-feed/use-thread-feed-list.tsx";
import type { ThreadFeedHandle, ThreadFeedProps } from "./thread-feed/types.ts";
import {
  MessageImage,
  MessageAttachmentImage,
  isImageAttachment,
  isFileAttachment,
  isMediaAttachment,
  UserMessageMedia,
  PendingMessageMedia,
  MessageAttachmentList,
  MessageAttachmentUnknown,
  THREAD_MEDIA_VIEWABILITY_CONFIG,
  ThreadFeedScrollView,
  ThreadMediaVisibility,
  MessageImageGalleryScope,
} from "./thread-feed/media.tsx";
import {
  WIDE_MARKDOWN_BLOCK_OPTIONS,
  MarkdownLinkHandlers,
  MarkdownStyleSets,
  MarkdownStyleSet,
  ARTIFACT_TEMPLATE_SYMBOL_BY_KIND,
  ArtifactTemplateCard,
  AssistantMarkdownContent,
  AssistantMarkdownBlocks,
  MarkdownDetailsFold,
  useMarkdownStyles,
} from "./thread-feed/markdown.tsx";
import {
  USER_MESSAGE_COPY_MENU_ACTIONS,
  UserMessageCopyButton,
  AssistantForkButton,
  UserMessageContentProps,
  UserMessageContent,
  UserMessageMarkdownContent,
  TurnDiffStat,
  AgentMessageFoldHeader,
  OpenSenderThreadButton,
  DisclosureLayout,
  DISCLOSURE_DETAIL_DELAY_MS,
  DISCLOSURE_DETAIL_FADE_MS,
  unsubscribeNothing,
  DisclosureRow,
} from "./thread-feed/message-rows.tsx";
import {
  ThreadAutomationMessageRow,
  compactionLabel,
  RunFoldButton,
} from "./thread-feed/automation-rows.tsx";
import {
  waitForThreadShell,
} from "./thread-feed/shell.ts";
import {
  MESSAGE_TIME_FORMATTER,
  formatMessageTime,
  TURN_FOLD_HEIGHT,
  FEED_PADDING_TOP,
  FEED_REFLOW_SETTLE_MS,
  FEED_REFLOW_HOLD_MS,
  USER_BUBBLE_HORIZONTAL_PADDING,
  ASSISTANT_ROW_HORIZONTAL_PADDING,
  FRESH_ENTRY_WINDOW_MS,
  isFreshTimestamp,
  ThreadFeedPlaceholder,
  useThreadFeedPresentation,
  ThreadFeedLoadEarlierControl,
} from "./thread-feed/placeholder.tsx";
import { renderFeedEntry } from "./thread-feed/feed-entry.tsx";
export type { ThreadFeedHandle, ThreadFeedHistoryControls } from "./thread-feed/types.ts";

export const ThreadFeed = memo(function ThreadFeed({
  ref,
  ...props
}: ThreadFeedProps & { readonly ref?: Ref<ThreadFeedHandle> }) {
  const view = useThreadFeedView(props);
  const markdown = useThreadFeedMarkdown(props, view);
  const list = useThreadFeedList(props, ref, { ...view, ...markdown });
  const surface = { ...view, ...markdown, ...list };
  const {
    workflowOpening,
    duoColumns,
    onOpenTurnDiff,
    themeAppearance,
    workRowSizing,
    viewportWidth,
    viewportHeight,
    disclosureToggleSettling,
    disclosureLayout,
    headerEndRef,
    disclosureTopSpace,
    reflowAnchorsSizeChanges,
    reflowFollowsEnd,
    listHeaderSizeRef,
    loadedListKeyRef,
    copiedRowId,
    expandedWorkRows,
    onInlinePlaybackStart,
    expandedFile,
    expandedVideo,
    closeFilePreview,
    closeVideoPreview,
    fileShareSourceIdentifier,
    horizontalPadding,
    contentLeftInset,
    contentRightInset,
    contentHorizontalPadding,
    contentWidth,
    userBubbleMaxWidth,
    markdownContentWidth,
    reviewCommentBubbleWidth,
    insets,
    topContentInset,
    bottomContentInset,
    usesNativeAutomaticInsets,
    initialContentInset,
    anchorTopInset,
    iconSubtleColor,
    replyActionSize,
    screenColor,
    userBubbleColor,
    markdownLinkHandlers,
    renderMarkdownImage,
    renderViewedImage,
    markdownStyles,
    renderReasoning,
    reviewCommentColors,
    unsettledTurnId,
    compactionLabelsByEntryId,
    listAppearanceData,
    handleScroll,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollBegin,
    handleMomentumScrollEnd,
    workGroupScrollPositions,
    setLoadedListKey,
    presentedFeed,
    setupAnchorIndex,
    groupedFeed,
    listMountKey,
    contentInsetEndAdjustment,
    attachList,
    followsEnd,
    holdReflowAnchor,
    handleViewportLayout,
    anchoredEndSpace,
    failedRunIds,
    terminalAssistantMessageIds,
    handleItemSizeChanged,
    maintainVisibleContentPosition,
    onCopyWorkRow,
    onToggleWorkGroup,
    onToggleWorkRow,
    onToggleTurnFold
  } = surface;

  const renderItem = (info: { item: GroupedThreadFeedRow; index: number }) => (
    <DisclosureRow
      key={info.item.id}
      itemKey={info.item.id}
      index={info.index}
      layout={disclosureLayout}
    >
      <MessageImageGalleryScope
        entry={info.item}
        environmentId={props.environmentId}
        threadId={props.threadId}
        workspaceRoot={props.workspaceRoot}
      >
        <ThreadMediaVisibility>
          {info.item.type === "message" &&
          !isCompactionCommandFeedEntry(info.item) &&
          info.item.message.projectedItem?.item.type === "user_message" &&
          info.item.message.projectedItem.item.modelSwitch ? (
            <ThreadModelSwitchDivider
              environmentId={props.environmentId}
              modelSwitch={info.item.message.projectedItem.item.modelSwitch}
              iconColor={iconSubtleColor}
            />
          ) : null}
          {renderFeedEntry(info, {
            userMessageGrouping: info.item.userMessageGrouping,
            environmentId: props.environmentId,
            dispatchingMessageId: props.dispatchingMessageId,
            onEditPendingMessage: props.onEditPendingMessage,
            onUseArtifactTemplate: props.onUseArtifactTemplate,
            threadId: props.threadId,
            copiedRowId,
            expandedWorkRows,
            workRowSizing,
            workGroupScrollPositions,
            terminalAssistantMessageIds,
            unsettledTurnId,
            compactionLabelsByEntryId,
            failedRunIds,
            onCopyWorkRow,
            onToggleWorkGroup,
            onToggleWorkRow,
            onToggleTurnFold,
            onOpenTurnDiff,
            onPressPreview: markdown.onPressPreview,
            onPlaybackStart: onInlinePlaybackStart,
            markdownLinkHandlers,
            renderMarkdownImage,
            renderViewedImage,
            renderReasoning,
            iconSubtleColor,
            replyActionSize,
            screenColor,
            userBubbleColor,
            markdownStyles,
            reviewCommentColors,
            reviewCommentBubbleWidth,
            themeAppearance,
            duoColumns,
            userBubbleMaxWidth,
            markdownContentWidth,
            contentWidth,
            threadTitle: props.threadTitle,
            skills: props.skills,
            workspaceRoot: props.workspaceRoot,
            workflowOpening,
          })}
          {props.worktreeSetup && info.index === setupAnchorIndex ? (
            <WorktreeSetupCard key={props.threadId} {...props.worktreeSetup} />
          ) : props.setupWorkingStartedAt && info.index === setupAnchorIndex ? (
            <WorktreeWorkingHeader startedAt={props.setupWorkingStartedAt} />
          ) : null}
        </ThreadMediaVisibility>
      </MessageImageGalleryScope>
    </DisclosureRow>
  );

  if (props.contentPresentation.kind === "unavailable" && props.queuedMessages.length === 0) {
    return (
      <ThreadFeedPlaceholder
        title={props.contentPresentation.title}
        detail={props.contentPresentation.detail}
        topInset={topContentInset}
        bottomInset={bottomContentInset}
        horizontalPadding={horizontalPadding}
      />
    );
  }

  return (
    <PresentationSource identifier={fileShareSourceIdentifier} style={{ flex: 1 }}>
      <View className="flex-1" onLayout={handleViewportLayout}>
        <View className="flex-1">
          {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- ThreadFeedScrollView is passed through the iOS-only spread below; the prop rejects undefined. */}
          <KeyboardAwareLegendList
            ref={attachList}
            // LegendList cannot see adjustedContentInset; remount so initial positioning waits for UIKit attachment.
            key={listMountKey}
            style={{ flex: 1 }}
            // RN 0.81+ drops inset-area touches (facebook/react-native#54123), making blank post-send space unscrollable.
            applyWorkaroundForContentInsetHitTestBug
            {...(Platform.OS === "ios" ? { ScrollViewComponent: ThreadFeedScrollView } : {})}
            // Horizontal Duo reservations are already included in the row padding.
            contentInsetAdjustmentBehavior={
              usesNativeAutomaticInsets
                ? duoColumns && props.layoutVariant === "split"
                  ? "scrollableAxes"
                  : "automatic"
                : "never"
            }
            automaticallyAdjustsScrollIndicatorInsets={usesNativeAutomaticInsets}
            {...(usesNativeAutomaticInsets
              ? {
                  // Manual contentInset zeroes UIKit's automatic header inset and scroll-edge region; derive it from the transparent header.
                  scrollIndicatorInsets: { top: 0, left: 0, right: 0, bottom: 0 },
                }
              : { scrollIndicatorInsets: { top: topContentInset, bottom: 0 } })}
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            // Patched LegendList math must allow -headerInset so short-content end scrolls rest below the header.
            contentInsetStartAdjustment={usesNativeAutomaticInsets ? anchorTopInset : 0}
            contentInsetEndAdjustment={props.contentInsetEndAdjustment}
            keyboardOffset={props.keyboardOffset}
            // UIKit adds the safe-area bottom to raw contentInset; ThreadDetailScreen under-reports it.
            // Include that extra inset in LegendList's scroll math so end scrolls reach the resting offset.
            contentInsetEndStaticAdjustment={usesNativeAutomaticInsets ? insets.bottom : 0}
            // Seed composer height until keyboard integration reports it, or Android's initial end scroll runs too early.
            {...(initialContentInset ? { contentInset: initialContentInset } : {})}
            adjustedInsetCompensation={usesNativeAutomaticInsets ? insets.bottom : 0}
            freeze={props.freeze}
            // Follow the measured end immediately; animating estimates races row measurement on acknowledgement.
            maintainScrollAtEnd={
              disclosureToggleSettling || props.sendingWithKeyboard || !followsEnd
                ? false
                : {
                    animated: false,
                    on: {
                      dataChange: true,
                      itemLayout: true,
                      layout: true,
                    },
                  }
            }
            // A reflow grows every visible row at once, well past the near-end threshold
            // that otherwise lets a status-bar tap leave the end.
            maintainScrollAtEndThreshold={reflowFollowsEnd ? Number.POSITIVE_INFINITY : undefined}
            sizeChangeAnchor={reflowAnchorsSizeChanges ? holdReflowAnchor : undefined}
            maintainVisibleContentPosition={
              (followsEnd && !disclosureToggleSettling) ||
              (disclosureToggleSettling && disclosureTopSpace > 0)
                ? false
                : maintainVisibleContentPosition
            }
            data={groupedFeed}
            extraData={listAppearanceData}
            renderItem={renderItem}
            viewabilityConfig={THREAD_MEDIA_VIEWABILITY_CONFIG}
            keyExtractor={(entry) => entry.id}
            getItemType={(entry) => {
              if (entry.type !== "message") return entry.type;
              if (isCompactionCommandFeedEntry(entry)) return "message:compaction";
              if (
                entry.message.role === "assistant" &&
                !terminalAssistantMessageIds.has(entry.message.id)
              ) {
                return "message:assistant-progress";
              }
              const { attribution } = resolveUserMessagePresentation(entry.message);
              return attribution === "automation" || attribution === "agent"
                ? `message:${attribution}`
                : `message:${entry.message.role}`;
            }}
            getFixedItemSize={list.getFixedItemSize}
            // Native layout transitions retain stale row positions during sync, even at duration zero.
            onItemSizeChanged={handleItemSizeChanged}
            drawDistance={500}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            keyboardLiftBehavior={props.sendingWithKeyboard ? "persistent" : "whenAtEnd"}
            // Seed viewport size to skip programmatic attach-time positioning, which races UIKit's adjustedContentInset.
            {...(viewportHeight > 0 && viewportWidth > 0
              ? { estimatedListSize: { height: viewportHeight, width: viewportWidth } }
              : {})}
            // Enable overflow: RN scrollTo clamps against raw insets and ignores the automatic header inset.
            scrollToOverflowEnabled
            estimatedItemSize={180}
            alignItemsAtEnd
            initialScrollAtEnd
            onLoad={() => {
              loadedListKeyRef.current = listMountKey;
              setLoadedListKey(listMountKey);
            }}
            // Row positions start below the header; the reflow anchor converts between them.
            onMetricsChange={(metrics) => {
              listHeaderSizeRef.current = metrics.headerSize;
            }}
            onScroll={handleScroll}
            onScrollBeginDrag={handleScrollBeginDrag}
            onScrollEndDrag={handleScrollEndDrag}
            onMomentumScrollBegin={handleMomentumScrollBegin}
            onMomentumScrollEnd={handleMomentumScrollEnd}
            scrollEventThrottle={16}
            ListHeaderComponent={
              <>
                {usesNativeAutomaticInsets ? null : <View style={{ height: topContentInset }} />}
                {setupAnchorIndex < 0 && props.worktreeSetup ? (
                  <WorktreeSetupCard key={props.threadId} {...props.worktreeSetup} />
                ) : null}
                {props.historyControls ? (
                  <ThreadFeedLoadEarlierControl {...props.historyControls} />
                ) : null}
                <View ref={headerEndRef} collapsable={false} />
              </>
            }
            ListFooterComponent={
              props.pendingHandoff ? (
                <ThreadHandoffDivider
                  environmentId={props.environmentId}
                  endpoints={props.pendingHandoff}
                  iconColor={iconSubtleColor}
                  surfaceColor={screenColor}
                  label="Context handoff pending"
                />
              ) : null
            }
            contentContainerStyle={{
              ...(props.fitShortFeedToViewport ? { minHeight: "100%" } : {}),
              paddingTop: FEED_PADDING_TOP + disclosureTopSpace,
              paddingLeft: contentHorizontalPadding + contentLeftInset,
              paddingRight: contentHorizontalPadding + contentRightInset,
            }}
          />
        </View>
        {presentedFeed.length === 0 &&
        !props.worktreeSetup &&
        props.activeWorkStartedAt === null &&
        props.contentPresentation.kind === "ready" ? (
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { left: contentLeftInset, right: contentRightInset }]}
          >
            <ThreadFeedPlaceholder
              title="No conversation yet"
              detail="Ask the agent to inspect the repo, run a command, or continue the active thread."
              topInset={topContentInset}
              bottomInset={bottomContentInset}
              horizontalPadding={horizontalPadding}
            />
          </View>
        ) : null}
        <VideoPreviewModal source={expandedVideo} onRequestClose={closeVideoPreview} />
        <FilePreviewModal source={expandedFile} onRequestClose={closeFilePreview} />
      </View>
    </PresentationSource>
  );
});
