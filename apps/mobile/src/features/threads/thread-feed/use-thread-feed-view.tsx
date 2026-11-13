/**
 * Thread feed presentation state: layout metrics, theme colours and markdown handlers.
 */
import { useOpenPullRequest } from "../../../native/useOpenPullRequest";
import { useWorkspaceSettledContentWidth } from "../../layout/workspace-content-width";
import { ThreadGuestPendingMessage, useThreadGuestShare } from "../ThreadGuestShareBar";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
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
import { HeaderHeightContext } from "@react-navigation/elements";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useNativeWorkspaceColumnsSupported } from "../../../native/NativeWorkspaceColumns";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { isDuoDevice } from "../../../lib/device-type";
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
import { useReduceMotionEnabled } from "../../../lib/appState";
import { FilePreviewModal, type FilePreviewSource } from "../../../components/FilePreviewModal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwindTheme } from "../../../lib/useUniwindTheme";
import { IOS_NAV_BAR_HEIGHT } from "../../../lib/layoutMetrics";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { VideoPreviewModal, type VideoPreviewSource } from "../../../components/VideoPreviewModal";
import { getReviewSectionIdForCheckpoint } from "../../review/reviewModel";
import { setReviewSelectedSectionId } from "../../review/reviewState";
import { useAndroidControlSizing } from "../../../components/ui/useAndroidControlSizing";
import {
  deriveCenteredContentHorizontalPadding,
  deriveThreadFeedInitialContentInset,
  deriveThreadWorkLogSizing,
  type LayoutVariant,
} from "../../../lib/layout";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import {
  resolveThreadFeedLiveFollow,
  resolveThreadFeedReflowAnchor,
  resolveThreadFeedReflowOffset,
  resolveThreadFeedReflowScroll,
  type ThreadFeedLiveFollowEvent,
  type ThreadFeedReflowAnchor,
  type ThreadWorkGroupScrollPosition,
} from "../thread-feed-live-follow";
import { ThreadWorkflowOpening, useWorkflowOpening } from "../thread-workflow-opening";
import { useFileChipShare } from "../useFileChipShare";
import { useOpenLinkedThread } from "../useOpenLinkedThread";
import type {
  DisclosureLayout,
} from "./message-rows.tsx";
import {
  ASSISTANT_ROW_HORIZONTAL_PADDING,
} from "./placeholder.tsx";
import type { ThreadFeedHandle, ThreadFeedProps } from "./types.ts";

export function useThreadFeedView(props: ThreadFeedProps) {
  const { listRef, onEndFollowEnabledChange, onHeaderMaterialVisibilityChange } = props;
  const workflowOpening = useWorkflowOpening(props.detailRef);
  const guestShare = useThreadGuestShare(props.detailRef);
  const deviceType = useDeviceType();
  const duoColumns = useNativeWorkspaceColumnsSupported() && isDuoDevice(deviceType);
  const openPullRequest = useOpenPullRequest();
  const navigation = useNavigation();
  const openLinkedThread = useOpenLinkedThread();
  const onOpenTurnDiff = useCallback(
    (checkpoint: ThreadCheckpointSummary) => {
      setReviewSelectedSectionId(
        scopedThreadKey(props.environmentId, props.threadId),
        getReviewSectionIdForCheckpoint(checkpoint),
      );
      navigation.navigate("ThreadReview", {
        environmentId: props.environmentId,
        threadId: props.threadId,
      });
    },
    [navigation, props.environmentId, props.threadId],
  );
  const { themeAppearance } = useAppearancePreferences();
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const userScrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headerMaterialVisibleRef = useRef(false);
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const { appearance } = useAppearancePreferences();
  const workRowSizing = deriveThreadWorkLogSizing({
    baseFontSize: appearance.baseFontSize,
    fontScale,
  });
  const settledPaneWidth = useWorkspaceSettledContentWidth();
  const [measuredViewportWidth, setViewportWidth] = useState(() =>
    props.layoutVariant === "split" ? 0 : windowWidth,
  );
  const viewportWidth =
    settledPaneWidth !== null ? Math.round(settledPaneWidth) : measuredViewportWidth;
  const [viewportHeight, setViewportHeight] = useState(0);
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  const [disclosureLayout, setDisclosureLayout] = useState<DisclosureLayout | null>(null);
  const disclosureMotionRef = useRef<DisclosureLayout | null>(null);
  const disclosureMotionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useReduceMotionEnabled();
  const headerEndRef = useRef<ComponentRef<typeof View>>(null);
  const lastFeedId = props.feed.at(-1)?.id;
  const [disclosureGap, setDisclosureGap] = useState<{
    space: number;
    tail: typeof lastFeedId;
  } | null>(null);
  const disclosureTopSpace = disclosureGap?.tail === lastFeedId ? (disclosureGap?.space ?? 0) : 0;
  // LegendList's geometric follow threshold can reclaim users reading history when streamed rows grow.
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  const endFollowEnabledRef = useRef(true);
  // Only user scrolls from drag through momentum break follow; ignore MVCP and programmatic adjustments.
  const userScrollSessionRef = useRef(false);
  const setEndFollow = (enabled: boolean) => {
    if (endFollowEnabledRef.current === enabled) {
      return;
    }
    endFollowEnabledRef.current = enabled;
    setEndFollowEnabled(enabled);
    onEndFollowEnabledChange?.(enabled);
  };
  const transitionEndFollow = (event: ThreadFeedLiveFollowEvent) => {
    setEndFollow(resolveThreadFeedLiveFollow(endFollowEnabledRef.current, event));
  };
  // Capture the reader's anchor before width reflow; LegendList thresholds see only new geometry.
  // iOS preserves it during re-measures. Android restores after because following disables MVCP.
  // undefined means no reflow; null means reflow with nothing to restore.
  const reflowAnchorRef = useRef<ThreadFeedReflowAnchor | null | undefined>(undefined);
  const reflowAnchorsSizeChanges = Platform.OS === "ios";
  const [reflowFollowsEnd, setReflowFollowsEnd] = useState(false);
  const reflowSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listHeaderSizeRef = useRef(0);
  const loadedListKeyRef = useRef<string | null>(null);
  const cancelReflow = () => {
    if (reflowAnchorRef.current === undefined) return;
    reflowAnchorRef.current = undefined;
    setReflowFollowsEnd(false);
  };
  const [interactionState, setInteractionState] = useState<{
    readonly copiedRowId: string | null;
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly expandedTurnIds: ReadonlySet<RunId>;
  }>({
    copiedRowId: null,
    expandedWorkGroups: {},
    expandedWorkRows: {},
    expandedTurnIds: new Set(),
  });
  const { copiedRowId, expandedWorkGroups, expandedWorkRows, expandedTurnIds } = interactionState;
  const markdownLinkRequest = useRef<AbortController | null>(null);
  const abortMarkdownLinkRequest = () => {
    markdownLinkRequest.current?.abort();
  };
  const beginMarkdownLinkRequest = () => {
    markdownLinkRequest.current?.abort();
    const request = new AbortController();
    markdownLinkRequest.current = request;
    return request;
  };
  const onInlinePlaybackStart = () => {
    markdownLinkRequest.current?.abort();
  };
  useFocusEffect(useCallback(() => () => markdownLinkRequest.current?.abort(), []));
  // A preview belongs to the thread and presentation it was opened from: a change closes it and
  // aborts a pending lookup.
  const markdownLinkScope = JSON.stringify([
    props.environmentId,
    props.threadId,
    props.contentPresentation.kind,
  ]);
  // oxlint-disable-next-line react/exhaustive-effect-dependencies, t3code/no-unreasoned-state-sync -- A scope change (thread or presentation) aborts the pending link lookup opened from the old scope.
  useLayoutEffect(() => () => markdownLinkRequest.current?.abort(), [markdownLinkScope]);
  const [preview, setPreview] = useState<{
    readonly scope: string;
    readonly file: FilePreviewSource | null;
    readonly video: VideoPreviewSource | null;
  } | null>(null);
  if (preview !== null && preview.scope !== markdownLinkScope) setPreview(null);
  const expandedFile = preview?.scope === markdownLinkScope ? preview.file : null;
  const expandedVideo = preview?.scope === markdownLinkScope ? preview.video : null;
  const openPreview = (
    scope: string,
    media: { file: FilePreviewSource } | { video: VideoPreviewSource },
  ) =>
    setPreview((current) => {
      const live = current?.scope === scope ? current : null;
      return {
        scope,
        file: "file" in media ? media.file : (live?.file ?? null),
        video: "video" in media ? media.video : (live?.video ?? null),
      };
    });
  const closeFilePreview = () =>
    setPreview((current) => (current === null ? null : { ...current, file: null }));
  const closeVideoPreview = () =>
    setPreview((current) => (current === null ? null : { ...current, video: null }));
  const fileShareSourceIdentifier = useId();
  const shareFileChip = useFileChipShare(
    props.environmentId,
    props.threadId,
    fileShareSourceIdentifier,
  );
  const horizontalPadding = props.layoutVariant === "split" ? 20 : 16;
  const contentLeftInset = props.contentSideInsets?.left ?? 0;
  const contentRightInset = props.contentSideInsets?.right ?? 0;
  const usableViewportWidth = Math.max(0, viewportWidth - contentLeftInset - contentRightInset);
  const contentHorizontalPadding = deriveCenteredContentHorizontalPadding({
    viewportWidth: usableViewportWidth,
    maxContentWidth: props.contentMaxWidth ?? null,
    minimumPadding: horizontalPadding,
  });
  const contentWidth = Math.max(0, usableViewportWidth - contentHorizontalPadding * 2);
  const userBubbleMaxWidth = contentWidth * 0.85;
  const markdownContentWidth = Math.max(0, contentWidth - ASSISTANT_ROW_HORIZONTAL_PADDING * 2);
  const reviewCommentBubbleWidth = Math.min(Math.max(280, contentWidth * 0.85), contentWidth);
  const insets = useSafeAreaInsets();
  const topContentInset = props.contentTopInset ?? insets.top + IOS_NAV_BAR_HEIGHT;
  const bottomContentInset = props.contentBottomInset ?? 18;
  const usesNativeAutomaticInsets =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios";
  const initialContentInset = deriveThreadFeedInitialContentInset({
    platform: Platform.OS,
    usesNativeAutomaticInsets,
    bottomContentInset,
  });
  // LegendList cannot see UIKit's adjustedContentInset; include header height in anchor offsets.
  const navigationHeaderHeight = useContext(HeaderHeightContext);
  const anchorTopInset = usesNativeAutomaticInsets
    ? (navigationHeaderHeight ?? insets.top + IOS_NAV_BAR_HEIGHT)
    : topContentInset;

  const theme = useUniwindTheme();
  const iconSubtleColor = theme["--color-icon-subtle"];
  const { buttonSize: androidButtonSize, smallIconSize: androidIconSize } =
    useAndroidControlSizing();
  const replyActionSize = useMemo(
    () =>
      Platform.OS === "android"
        ? { button: androidButtonSize, icon: androidIconSize }
        : { button: 28, icon: 13 },
    [androidButtonSize, androidIconSize],
  );
  const screenColor = theme["--color-screen"];
  const userBubbleColor = theme["--color-user-bubble"];

  return {
    listRef,
    onEndFollowEnabledChange,
    onHeaderMaterialVisibilityChange,
    workflowOpening,
    guestShare,
    deviceType,
    duoColumns,
    openPullRequest,
    navigation,
    openLinkedThread,
    onOpenTurnDiff,
    themeAppearance,
    copyFeedbackTimeoutRef,
    disclosureSettleFrameRef,
    disclosureSettleSecondFrameRef,
    disclosureAnchorKeyRef,
    userScrollSettleTimerRef,
    headerMaterialVisibleRef,
    windowWidth,
    fontScale,
    appearance,
    workRowSizing,
    settledPaneWidth,
    measuredViewportWidth,
    setViewportWidth,
    viewportWidth,
    viewportHeight,
    setViewportHeight,
    disclosureToggleSettling,
    setDisclosureToggleSettling,
    disclosureLayout,
    setDisclosureLayout,
    disclosureMotionRef,
    disclosureMotionTimer,
    reduceMotion,
    headerEndRef,
    lastFeedId,
    disclosureGap,
    setDisclosureGap,
    disclosureTopSpace,
    endFollowEnabled,
    setEndFollowEnabled,
    endFollowEnabledRef,
    userScrollSessionRef,
    setEndFollow,
    transitionEndFollow,
    reflowAnchorRef,
    reflowAnchorsSizeChanges,
    reflowFollowsEnd,
    setReflowFollowsEnd,
    reflowSettleTimerRef,
    listHeaderSizeRef,
    loadedListKeyRef,
    cancelReflow,
    interactionState,
    setInteractionState,
    copiedRowId,
    expandedWorkGroups,
    expandedWorkRows,
    expandedTurnIds,
    abortMarkdownLinkRequest,
    beginMarkdownLinkRequest,
    onInlinePlaybackStart,
    markdownLinkScope,
    preview,
    setPreview,
    expandedFile,
    expandedVideo,
    openPreview,
    closeFilePreview,
    closeVideoPreview,
    fileShareSourceIdentifier,
    shareFileChip,
    horizontalPadding,
    contentLeftInset,
    contentRightInset,
    usableViewportWidth,
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
    navigationHeaderHeight,
    anchorTopInset,
    theme,
    iconSubtleColor,
    androidButtonSize,
    androidIconSize,
    replyActionSize,
    screenColor,
    userBubbleColor,
  };
}

export type ThreadFeedView = ReturnType<typeof useThreadFeedView>;
