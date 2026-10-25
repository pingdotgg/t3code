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
import { ThreadHandoffDivider, ThreadHandoffRow } from "./thread-handoff-row";
import { GuestBubbleTint, GuestMessageName } from "./guestMessageStyle";
import { ThreadGuestPendingMessage, useThreadGuestShare } from "./ThreadGuestShareBar";
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
} from "@t3tools/contracts";
import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import { parseThreadLinkHref, resolveThreadLinkRef } from "@t3tools/shared/threadLinks";
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
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";
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
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type ComponentPropsWithRef,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  type ColorValue,
  useWindowDimensions,
  View,
} from "react-native";
import { Image as ExpoImage } from "expo-image";
import { useResolveClassNames } from "uniwind";
import { useFilePreviewGallery, FilePreviewGallery } from "../../components/FilePreviewGallery";
import { assetImageSource } from "../../lib/assetImageSource";
import { composerImageGallery } from "../../lib/composerImageGallery";
import { messageImageGallery } from "./messageImageGallery";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { isPdfFile } from "../../lib/filePreview";
import { flattenThemeColor } from "../../lib/mobileTheme";
import { PresentationSource } from "../../components/ui/NativePresentation";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeInUp, type SharedValue } from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { FONT_FAMILIES } from "../../lib/fontFamilies";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { hasWideMarkdownBlock } from "../../lib/wideMarkdownBlocks";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
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
import { VideoAttachmentTile } from "../../components/VideoAttachmentTile";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import {
  attachmentVideoPreviewSource,
  mediaVideoPreviewUri,
  mediaVideoThumbnailKey,
  type MediaVideoPreviewSource,
} from "../../lib/videoPreviewSource";
import { CopyTextButton } from "./CopyTextButton";
import { getReviewSectionIdForCheckpoint } from "../review/reviewModel";
import { setReviewSelectedSectionId } from "../review/reviewState";
import { Menu } from "../../components/ui/Menu";
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
import {
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
} from "../../lib/appearancePreferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import {
  normalizeNativeMarkdownUrl,
  resolveMarkdownInlineCodePresentation,
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
  isCompactionCommandFeedEntry,
  type PendingThreadFeedEntry,
  type ThreadFeedRow,
} from "./pending-thread-feed";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { resolveThreadFeedFixedItemSize } from "./thread-feed-item-size";
import { htmlRenderFrameHeight } from "@t3tools/shared/htmlRender";
import { htmlRenderRowHeight, ThreadHtmlRender } from "./HtmlRenderWebView";
import { ThreadMcpApp } from "./McpAppWebView";
import {
  assetEnvironment,
  useAssetUrl,
  useAssetUrlState,
  useRefreshAssetUrl,
} from "../../state/assets";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { readEnvironmentScope, usePreparedConnection } from "../../state/session";
import { projectEnvironment } from "../../state/projects";
import {
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import {
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

const WIDE_MARKDOWN_BLOCK_OPTIONS = {
  // iOS blockquotes and selectable text measure separately; definite bubble width matches UIKit's drawing width.
  includeBlockquotes: Platform.OS === "ios",
  includeOrderedLists: Platform.OS === "android",
} as const;

const MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
function formatMessageTime(input: string): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  return MESSAGE_TIME_FORMATTER.format(timestamp);
}

const TURN_FOLD_HEIGHT = 42;
const FEED_PADDING_TOP = 12;
// Rows re-measure within a commit or two of a width change. LegendList also defers imperative
// scrolls for 100ms after it compensates a size change, and a deferred restore could land
// under a drag that starts meanwhile.
const FEED_REFLOW_SETTLE_MS = 200;
// A fold resizes the feed in steps about 200ms apart. Holding the place taken at the first step
// across all of them keeps a passing moment off the end from re-anchoring the rest to a row.
const FEED_REFLOW_HOLD_MS = 600;
const USER_BUBBLE_HORIZONTAL_PADDING = 3.5 * 3.5;
const ASSISTANT_ROW_HORIZONTAL_PADDING = 3.5;
const THREAD_FEED_DISCLOSURE_ENTER_TRANSITION = FadeIn.delay(
  THREAD_DISCLOSURE_TRANSITION_MS,
).duration(140);

// Virtualization remounts old rows; only newly created content should replay an entrance.
const FRESH_ENTRY_WINDOW_MS = 3_000;
function isFreshTimestamp(input: string): boolean {
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ENTRY_WINDOW_MS;
}

export interface ThreadFeedHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: () => void;
  /** Loads earlier history down to the entry, in one request. */
  readonly onLoadThrough: (entryId: string) => void;
}

export interface ThreadFeedProps {
  readonly worktreeSetup?: WorktreeSetupCardProps | null;
  readonly setupWorkingStartedAt?: string | null;
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly dispatchingMessageId: MessageId | null;
  readonly onEditPendingMessage: ((message: QueuedThreadMessage) => void) | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly workspaceRoot?: string | null;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly pendingHandoff?: HandoffEndpoints | null;
  readonly contentPresentation: ThreadContentPresentation;
  readonly agentLabel: string;
  readonly latestRun: ThreadFeedLatestRun | null;
  readonly activeWorkStartedAt: string | null;
  readonly runlessWorkActive?: boolean;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly freeze: SharedValue<boolean>;
  readonly anchorMessageId: MessageId | null;
  /** A message to scroll to once it is in the feed; see `onJumpedToMessage`. */
  readonly jumpToMessageId?: MessageId | null;
  readonly onJumpedToMessage?: () => void;
  readonly submittedMessageId: MessageId | null;
  readonly contentInsetEndAdjustment: SharedValue<number>;
  readonly keyboardOffset: number;
  readonly contentTopInset?: number;
  readonly contentBottomInset?: number;
  readonly historyControls?: ThreadFeedHistoryControls;
  readonly contentMaxWidth?: number;
  readonly contentSideInsets?: { readonly left: number; readonly right: number };
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onEndFollowEnabledChange?: (enabled: boolean) => void;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
}

async function waitForThreadShell(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<boolean> {
  const atom = environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId));
  return waitForThreadShellReady({
    read: () => appAtomRegistry.get(atom) !== null,
  });
}

const USER_MESSAGE_COPY_MENU_ACTIONS = [
  { id: "copy-prompt-link", title: "Copy prompt link", image: "link" },
];

function UserMessageCopyButton(props: {
  readonly text: string;
  readonly onCopy: (() => Promise<void>) | undefined;
  readonly tintColor: ColorValue;
}) {
  const button = (
    <CopyTextButton
      accessibilityLabel="Copy message"
      text={props.text}
      onCopy={props.onCopy}
      tintColor={props.tintColor}
      buttonSize={28}
      iconSize={13}
    />
  );
  const linkText = replaceComposerContextReferences(props.text, (reference) => reference.label);
  if (linkText.length > PROMPT_LINK_MAX_PROMPT_LENGTH) return button;
  return (
    <Menu
      actions={USER_MESSAGE_COPY_MENU_ACTIONS}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "copy-prompt-link") void copyPromptLink(linkText);
      }}
      shouldOpenOnLongPress
    >
      {button}
    </Menu>
  );
}

function AssistantForkButton(props: {
  readonly environmentId: EnvironmentId;
  readonly iconColor: ColorValue;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly sourceTitle: string;
}) {
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, "fork from response");
  const navigation = useNavigation();
  const [busy, setBusy] = useState(false);
  const canFork = canForkProjectedAssistantItem({
    projectedItem: props.projectedItem,
    capabilities: support.providerSession?.capabilities,
  });
  const runId = props.projectedItem.item.runId;

  if (!canFork || runId === null) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Fork from this response"
      disabled={busy}
      onPress={() => {
        const targetThreadId = ThreadId.make(uuidv4());
        setBusy(true);
        void Haptics.selectionAsync();
        void forkFromRun({
          environmentId: props.environmentId,
          input: {
            sourceThreadId: props.projectedItem.sourceThreadId,
            targetThreadId,
            runId,
            title: `${props.sourceTitle} fork`,
            creationSource: "mobile",
          },
        })
          .then(async (result) => {
            if (result._tag !== "Success") return;
            const targetThreadReady = await waitForThreadShell(props.environmentId, targetThreadId);
            if (!targetThreadReady) {
              Dialog.alert(
                "Fork created",
                "Its thread data did not reach this client. Reconnect and try opening it from the thread list.",
              );
              return;
            }
            navigation.navigate("Thread", {
              environmentId: props.environmentId,
              threadId: targetThreadId,
            });
          })
          .finally(() => setBusy(false));
      }}
      className="h-7 w-7 items-center justify-center disabled:opacity-40"
    >
      {busy ? (
        <AppActivityIndicator size="small" />
      ) : (
        <SymbolView
          name="arrow.triangle.branch"
          size={13}
          tintColor={props.iconColor}
          type="monochrome"
        />
      )}
    </Pressable>
  );
}

function MessageAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly className: string;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const withGallery = useFilePreviewGallery();
  const sourceIdentifier = useId();
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId: props.attachmentId,
      fileName: props.name,
      mimeType: props.mimeType,
    }),
    [props.attachmentId, props.name, props.mimeType],
  );
  const uri = useAssetUrl(props.environmentId, resource);
  const refreshAssetUrl = useRefreshAssetUrl(props.environmentId, resource);
  const retriedImage = useRef(false);
  const imageStyle = useResolveClassNames(props.className);

  if (uri === null) {
    return (
      <View className={`${props.className} items-center justify-center`}>
        <AppActivityIndicator />
      </View>
    );
  }

  return (
    <PresentationSource identifier={sourceIdentifier}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open ${props.name}`}
        onPress={() =>
          props.onPressPreview(
            withGallery({
              kind: "image",
              environmentId: props.environmentId,
              resource,
              name: props.name,
              sourceIdentifier,
              actionsSource: {
                name: props.name,
                mimeType: props.mimeType,
                environmentId: props.environmentId,
                resource,
              },
            }),
          )
        }
      >
        <ExpoImage
          source={assetImageSource(props.environmentId, resource, uri)}
          cachePolicy="memory-disk"
          style={imageStyle}
          contentFit="cover"
          onLoad={() => {
            retriedImage.current = false;
          }}
          onError={() => {
            if (retriedImage.current) return;
            retriedImage.current = true;
            void refreshAssetUrl();
          }}
        />
      </Pressable>
    </PresentationSource>
  );
}

function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {
  return attachment.type === "image" || imageMimeType(attachment) !== null;
}

function isFileAttachment(attachment: ChatAttachment): attachment is ChatFileAttachment {
  return attachment.type === "file";
}

function MessageAttachmentFile(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatFileAttachment;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onPressVideo: (attachment: ChatFileAttachment, sourceIdentifier: string) => void;
}) {
  const sourceIdentifier = useId();
  const navigation = useNavigation();
  const { selectedThread } = useThreadSelection();
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  const preparedConnection = usePreparedConnection(props.environmentId);
  const { attachment } = props;
  const videoType = videoMimeType(attachment);
  const isPdf = isPdfFile(attachment);
  const fileTypeLabel = isPdf
    ? "PDF"
    : (attachment.name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toUpperCase() ?? "File");
  const sizeLabel = formatAttachmentSize(attachment.sizeBytes);
  const thumbnailUrl = useAssetUrl(
    props.environmentId,
    videoType === null
      ? null
      : {
          _tag: "attachment",
          attachmentId: attachment.id,
          fileName: attachment.name,
          mimeType: videoType,
        },
  );
  const httpBaseUrl = Option.isSome(preparedConnection)
    ? preparedConnection.value.httpBaseUrl
    : null;
  const openingRef = useRef<AbortController | null>(null);
  const [opening, setOpening] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setOpening(false);
      return () => {
        openingRef.current?.abort();
        openingRef.current = null;
      };
    }, [props.environmentId, attachment.id, httpBaseUrl]),
  );

  const shareFile = (sourceIdentifier?: string) => {
    if (httpBaseUrl === null || openingRef.current) return;
    const controller = new AbortController();
    openingRef.current = controller;
    setOpening(true);
    const finish = (message: string | null) => {
      if (message !== null && !controller.signal.aborted) {
        Dialog.alert("Could not open attachment", message);
      }
      if (openingRef.current === controller) {
        openingRef.current = null;
        setOpening(false);
      }
    };
    void (async () => {
      const result = await createAssetUrl({
        environmentId: props.environmentId,
        input: {
          resource: {
            _tag: "attachment",
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
          },
        },
      });
      if (controller.signal.aborted) return finish(null);
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        return finish(error instanceof Error ? error.message : "The attachment is unavailable.");
      }
      const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
      if (url === null) return finish("The attachment could not be opened.");
      const shared = await settlePromise(() =>
        downloadAndShareAttachment({
          url,
          attachment,
          signal: controller.signal,
          sourceIdentifier,
        }),
      );
      if (shared._tag === "Failure") {
        const error = squashAtomCommandFailure(shared);
        return finish(error instanceof Error ? error.message : "The attachment is unavailable.");
      }
      finish(null);
    })();
  };

  if (videoType !== null) {
    const sourceIdentifier = `attachment:${props.environmentId}:${attachment.id}`;
    return (
      <VideoAttachmentTile
        name={attachment.name}
        sourceIdentifier={sourceIdentifier}
        thumbnailSource={thumbnailUrl}
        actionsSource={
          attachmentVideoPreviewSource(props.environmentId, attachment, sourceIdentifier)
            .actionsSource
        }
        disabled={opening || httpBaseUrl === null}
        onPress={(sourceIdentifier) => props.onPressVideo(attachment, sourceIdentifier)}
        className="my-1 rounded-2xl"
        style={{ width: 224, maxWidth: "100%", aspectRatio: 16 / 9 }}
      />
    );
  }

  return (
    <>
      <PresentationSource
        identifier={sourceIdentifier}
        className="my-1"
        style={{ width: 280, maxWidth: "100%" }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${attachment.name}`}
          accessibilityValue={{ text: `${fileTypeLabel}, ${sizeLabel}` }}
          accessibilityState={{ disabled: opening || httpBaseUrl === null, busy: opening }}
          disabled={opening || httpBaseUrl === null}
          className="min-w-0 flex-row items-center gap-3 rounded-xl border border-border bg-card p-3 active:bg-subtle"
          onLongPress={() => shareFile(sourceIdentifier)}
          onPress={() =>
            isPdf
              ? props.onPressPreview({
                  kind: "pdf",
                  name: attachment.name,
                  environmentId: props.environmentId,
                  resource: {
                    _tag: "attachment",
                    attachmentId: attachment.id,
                    fileName: attachment.name,
                    mimeType: "application/pdf",
                  },
                  sourceIdentifier,
                })
              : navigation.navigate("ThreadAttachment", {
                  environmentId: String(props.environmentId),
                  ...(selectedThread ? { threadId: String(selectedThread.id) } : {}),
                  attachmentId: attachment.id,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: String(attachment.sizeBytes),
                })
          }
        >
          <View className="h-12 w-10 shrink-0 items-center justify-center rounded-lg bg-subtle">
            {opening ? (
              <AppActivityIndicator size="small" />
            ) : (
              <PierreEntryIcon path={attachment.name} kind="file" size={26} />
            )}
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <Text className="font-t3-medium text-sm text-foreground" numberOfLines={2}>
              {attachment.name}
            </Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {fileTypeLabel} · {sizeLabel}
            </Text>
          </View>
          <SymbolView
            name="chevron.right"
            size={12}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
        </Pressable>
      </PresentationSource>
    </>
  );
}

/** A message's files as its bubble shows them; a guest's waiting message uses it too. */
function MessageAttachmentList(props: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly environmentId: EnvironmentId;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onPressVideo: (attachment: ChatFileAttachment, sourceIdentifier: string) => void;
}) {
  return props.attachments.map((attachment) =>
    isImageAttachment(attachment) ? (
      <MessageAttachmentImage
        key={attachment.id}
        environmentId={props.environmentId}
        attachmentId={attachment.id}
        name={attachment.name}
        mimeType={attachment.mimeType}
        className="mt-1.5 aspect-[1.3] w-full rounded-[18px] bg-subtle-strong"
        onPressPreview={props.onPressPreview}
      />
    ) : isFileAttachment(attachment) ? (
      <MessageAttachmentFile
        key={attachment.id}
        environmentId={props.environmentId}
        attachment={attachment}
        onPressPreview={props.onPressPreview}
        onPressVideo={props.onPressVideo}
      />
    ) : (
      <MessageAttachmentUnknown key={attachment.id} name={attachment.name} />
    ),
  );
}

function MessageAttachmentUnknown(props: { readonly name: string }) {
  return (
    <View className="flex-row items-center gap-2 py-1">
      <PierreEntryIcon path={props.name} kind="file" size={16} />
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {props.name}
      </Text>
    </View>
  );
}

// LegendList only computes hook visibility when the list has a viewability config.
const THREAD_MEDIA_VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0 };

// The composer and overlays beside the feed keep UIKit from finding it on its own, so
// register it with the screen controller. Header minimization observes this scroll view.
function ThreadFeedScrollView(props: ComponentPropsWithRef<typeof Animated.ScrollView>) {
  return (
    <NativeScrollViewMarker style={{ flex: 1 }}>
      <Animated.ScrollView {...props} />
    </NativeScrollViewMarker>
  );
}

function ThreadMediaVisibility(props: { readonly children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useViewabilityAmount<ThreadFeedEntry>(
    useCallback((token) => setVisible(token.sizeVisible > 0), []),
  );
  return <ThreadMediaVisibleContext value={visible}>{props.children}</ThreadMediaVisibleContext>;
}

interface MarkdownLinkHandlers {
  readonly onLinkPress: (href: string) => void;
  readonly fileContextMenu: (href: string) => MarkdownFileContextMenu | undefined;
  readonly onFileContextMenuAction: (href: string, actionId: string) => void;
  readonly onImagePress?: (href: string) => void;
  readonly resolveImageSource?: MarkdownImageSourceResolver;
  readonly linkCustomization?: (href: string) => MarkdownLinkCustomization | undefined;
}

interface MarkdownStyleSets {
  readonly user: MarkdownStyleSet;
  readonly assistant: MarkdownStyleSet;
}

interface MarkdownStyleSet {
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

const ARTIFACT_TEMPLATE_SYMBOL_BY_KIND: Record<
  CodexArtifactTemplate["artifactKind"],
  AppSymbolName
> = {
  document: "doc.text",
  presentation: "chart.bar.xaxis",
  spreadsheet: "chart.bar.xaxis",
  site: "safari",
  "google-docs": "doc.text",
  "google-slides": "chart.bar.xaxis",
  "google-sheets": "chart.bar.xaxis",
  image: "camera",
  email: "text.bubble",
  slack: "text.bubble",
};

function ArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate;
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined;
}) {
  return (
    <View className="my-2 min-w-0 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3">
      <View className="relative h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-subtle">
        <SymbolView
          name={ARTIFACT_TEMPLATE_SYMBOL_BY_KIND[props.template.artifactKind]}
          size={20}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        <View className="absolute -right-1 -bottom-1 h-4 w-4 items-center justify-center rounded-full bg-fuchsia-500">
          <SymbolView
            name={{ ios: "sparkles", android: "auto_awesome" }}
            size={9}
            tintColor="white"
            type="monochrome"
          />
        </View>
      </View>
      <View className="min-w-0 flex-1">
        <Text className="font-t3-bold text-sm text-foreground" numberOfLines={1}>
          {props.template.displayName}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {codexArtifactTemplatePresentationLabel(props.template.artifactKind)}
        </Text>
      </View>
      {props.onUse ? (
        <Button
          label="Use template"
          tone="secondary"
          accessibilityLabel={`Use ${props.template.displayName} template`}
          onPress={() => props.onUse?.(props.template)}
        />
      ) : null}
    </View>
  );
}

const AssistantMarkdownContent = memo(function AssistantMarkdownContent(props: {
  readonly markdown: string;
  readonly environmentId: EnvironmentId;
  readonly markdownStyles: MarkdownStyleSet;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  readonly renderImage: MarkdownImageRenderer;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined;
}) {
  const liveMarkdown = useLiveThreadLinkLabels(props.markdown, props.environmentId);
  const segments = useMemo(() => splitCodexArtifactTemplateMarkdown(liveMarkdown), [liveMarkdown]);
  const threadIcons = useThreadChipIcons(props.environmentId, liveMarkdown);
  const linkHandlers: MarkdownLinkHandlers = {
    ...props.linkHandlers,
    linkCustomization: (href) =>
      withChipIcon(props.linkHandlers.linkCustomization?.(href), threadIcons.get(href)),
  };

  return segments.map((segment) => {
    if (segment.kind === "artifact-template") {
      return (
        <ArtifactTemplateCard
          key={`artifact-template:${segment.sourceOffset}`}
          template={segment.template}
          onUse={props.onUseArtifactTemplate}
        />
      );
    }
    if (segment.markdown.trim().length === 0) return null;

    const markdown = renderCodexInlineDirectivesAsMarkdown(segment.markdown);
    return (
      <SelectableMarkdownText
        key={`markdown:${segment.sourceOffset}`}
        markdown={markdown}
        skills={props.skills}
        textStyle={props.markdownStyles.nativeTextStyle}
        {...linkHandlers}
        renderImage={props.renderImage}
      />
    );
  });
});

function useMarkdownStyles(): MarkdownStyleSets {
  const { appearance } = useAppearancePreferences();
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const theme = useUniwindTheme();
  const markdownBodyColor = theme["--color-md-body"];
  const markdownStrongColor = theme["--color-md-strong"];
  const markdownLinkColor = theme["--color-md-link"];
  const markdownBlockquoteBorder = theme["--color-md-blockquote-border"];
  const markdownCodeBg = theme["--color-md-code-bg"];
  const markdownCodeText = theme["--color-md-code-text"];
  const markdownInlineCodeText = theme["--color-foreground-secondary"];
  const markdownHrColor = theme["--color-md-hr"];
  // Native chip drawing parses opaque hex only, and this role is translucent.
  const contextChipBorderColor = flattenThemeColor(
    theme["--color-border"],
    theme["--color-user-bubble"],
  );
  const markdownUserBodyColor = theme["--color-user-bubble-foreground"];
  const markdownUserCodeBg = theme["--color-md-user-code-bg"];
  const markdownUserCodeText = theme["--color-md-user-code-text"];
  const markdownUserInlineCodeText = theme["--color-user-bubble-foreground-muted"];
  const markdownUserFenceBg = theme["--color-md-user-fence-bg"];
  const regularFontFamily = FONT_FAMILIES.regular;
  const boldFontFamily = FONT_FAMILIES.bold;

  return useMemo(() => {
    return {
      user: {
        nativeTextStyle: {
          color: markdownUserBodyColor,
          strongColor: markdownUserBodyColor,
          mutedColor: markdownUserBodyColor,
          linkColor: markdownUserBodyColor,
          inlineCodeColor: markdownUserInlineCodeText,
          codeColor: markdownUserCodeText,
          codeBackgroundColor: markdownUserCodeBg,
          codeBlockBackgroundColor: markdownUserFenceBg,
          fileTextColor: markdownUserBodyColor,
          quoteMarkerColor: markdownUserBodyColor,
          dividerColor: markdownUserBodyColor,
          contextChipBorderColor,
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
        },
      },
      assistant: {
        nativeTextStyle: {
          color: markdownBodyColor,
          strongColor: markdownStrongColor,
          mutedColor: markdownBodyColor,
          linkColor: markdownLinkColor,
          inlineCodeColor: markdownInlineCodeText,
          codeColor: markdownCodeText,
          codeBackgroundColor: markdownCodeBg,
          codeBlockBackgroundColor: markdownCodeBg,
          fileTextColor: markdownCodeText,
          quoteMarkerColor: markdownBlockquoteBorder,
          dividerColor: markdownHrColor,
          contextChipBorderColor,
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
        },
      },
    };
  }, [
    boldFontFamily,
    contextChipBorderColor,
    markdownBlockquoteBorder,
    markdownBodyColor,
    markdownCodeBg,
    markdownCodeText,
    markdownHrColor,
    markdownInlineCodeText,
    markdownLinkColor,
    markdownStrongColor,
    markdownUserBodyColor,
    markdownUserCodeBg,
    markdownUserCodeText,
    markdownUserFenceBg,
    markdownUserInlineCodeText,
    nativeMarkdownTypography,
    regularFontFamily,
  ]);
}

/** Messages from other agents fold to one line so the user's own messages stay easy to find. */
function AgentMessageFoldHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly senderThreadId?: ThreadId;
  readonly summary: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly iconSubtleColor: ColorValue;
}) {
  const senderShell = useQuietThreadShell(
    props.senderThreadId ? scopeThreadRef(props.environmentId, props.senderThreadId) : null,
  );
  const label = senderShell?.title.trim() || "Agent";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${props.summary}`}
      accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} the message.`}
      accessibilityState={{ expanded: props.expanded }}
      hitSlop={4}
      className="min-h-10 flex-row items-center gap-1.5 px-3.5 py-2"
      onPress={() => {
        void Haptics.selectionAsync();
        props.onToggle();
      }}
    >
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={14}
        weight="medium"
        tintColorClassName="accent-user-bubble-foreground-muted"
        type="monochrome"
      />
      <Text
        numberOfLines={1}
        className="max-w-[50%] shrink-0 font-t3-medium text-sm text-user-bubble-foreground-muted"
      >
        {label}
      </Text>
      <Text numberOfLines={1} className="min-w-0 shrink text-sm text-user-bubble-foreground">
        {props.summary}
      </Text>
      <ThreadDisclosureChevron
        expanded={props.expanded}
        collapsedDirection="down"
        size={11}
        tintColor={props.iconSubtleColor}
      />
    </Pressable>
  );
}

function OpenSenderThreadButton(props: {
  readonly environmentId: EnvironmentId;
  readonly senderThreadId: ThreadId;
}) {
  const openLinkedThread = useOpenLinkedThread();
  return (
    <Pressable
      accessibilityRole="link"
      hitSlop={6}
      onPress={() =>
        openLinkedThread({
          environmentId: String(props.environmentId),
          threadId: String(props.senderThreadId),
        })
      }
    >
      <Text className="font-t3-medium text-xs text-foreground-secondary">Open thread</Text>
    </Pressable>
  );
}

/** Automation prompts are long, repeated runbooks; a folded bubble keeps them out of the way. */
function ThreadAutomationMessageRow(props: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly context?: OrchestrationMessageContext;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  readonly timestampLabel: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly bubbleColor: ColorValue;
  readonly bubbleMaxWidth: number | "85%";
  readonly contentMaxWidth: number;
  readonly iconSubtleColor: ColorValue;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly renderImage: MarkdownImageRenderer;
}) {
  const navigation = useNavigation();
  const tasks = useEnvironmentQuery(
    props.scheduledTaskId
      ? serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const taskTitle = tasks.data?.tasks.find((task) => task.id === props.scheduledTaskId)?.title;
  const summary = taskTitle ?? props.text.trim().split(/\r?\n/, 1)[0] ?? "";

  return (
    <View className="mb-5 items-end">
      <View
        className="min-w-0 rounded-[20px]"
        style={{
          backgroundColor: props.bubbleColor,
          maxWidth: props.bubbleMaxWidth,
          ...(props.expanded ? { width: props.bubbleMaxWidth } : null),
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Automation: ${summary}`}
          accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} the prompt.`}
          accessibilityState={{ expanded: props.expanded }}
          hitSlop={4}
          className="min-h-10 flex-row items-center gap-1.5 px-3.5 py-2"
          onPress={() => {
            void Haptics.selectionAsync();
            props.onToggle();
          }}
        >
          <SymbolView
            name="calendar.badge.clock"
            size={14}
            weight="medium"
            tintColorClassName="accent-user-bubble-foreground-muted"
            type="monochrome"
          />
          <Text className="font-t3-medium text-sm text-user-bubble-foreground-muted">
            Automation
          </Text>
          <Text numberOfLines={1} className="min-w-0 shrink text-sm text-user-bubble-foreground">
            {summary}
          </Text>
          <ThreadDisclosureChevron
            expanded={props.expanded}
            collapsedDirection="down"
            size={11}
            tintColor={props.iconSubtleColor}
          />
        </Pressable>
        {props.expanded ? (
          <View className="px-3.5 pb-2.5">
            <MarkdownImageAvailableWidthContext value={props.contentMaxWidth}>
              <UserMessageContent
                text={renderAssistantCitationsAsText(props.text)}
                environmentId={props.environmentId}
                context={props.context}
                markdownStyles={props.markdownStyles}
                reviewCommentColors={props.reviewCommentColors}
                skills={props.skills}
                linkHandlers={props.linkHandlers}
                renderImage={props.renderImage}
              />
            </MarkdownImageAvailableWidthContext>
          </View>
        ) : null}
      </View>
      {props.expanded ? (
        <View className="mt-1 flex-row items-center justify-end gap-2 pr-0.5">
          {props.scheduledTaskId ? (
            <Pressable
              accessibilityRole="link"
              hitSlop={6}
              onPress={() => openSettings(navigation, "SettingsScheduledTasks")}
            >
              <Text className="font-t3-medium text-xs text-foreground-secondary">
                Open automation
              </Text>
            </Pressable>
          ) : null}
          <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
            {props.timestampLabel}
          </Text>
          <UserMessageCopyButton
            text={props.text}
            onCopy={undefined}
            tintColor={props.iconSubtleColor}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Leads with why T3 Code compacted, when it did so without being asked. */
function compactionLabel(label: string, title: string | undefined) {
  return title !== undefined && label.startsWith("Context compacted")
    ? title + label.slice("Context compacted".length)
    : label;
}

function renderFeedEntry(
  info: { item: ThreadFeedRow; index: number },
  props: Pick<
    ThreadFeedProps,
    | "environmentId"
    | "onUseArtifactTemplate"
    | "skills"
    | "dispatchingMessageId"
    | "onEditPendingMessage"
    | "threadId"
    | "workspaceRoot"
  > & {
    readonly copiedRowId: string | null;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly workRowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
    readonly workGroupScrollPositions: Map<string, ThreadWorkGroupScrollPosition>;
    readonly terminalAssistantMessageIds: ReadonlySet<string>;
    readonly unsettledTurnId: RunId | null;
    readonly compactionLabelsByEntryId: ReadonlyMap<string, { title: string; compacting: string }>;
    readonly failedRunIds: ReadonlySet<RunId>;
    readonly onCopyWorkRow: (rowId: string, value: string) => void;
    readonly onToggleWorkGroup: (groupId: string, anchorKey?: string) => void;
    readonly onToggleWorkRow: (rowId: string, anchorKey?: string, groupId?: string) => void;
    readonly onToggleTurnFold: (runId: RunId) => void;
    readonly onOpenTurnDiff: (checkpoint: ThreadCheckpointSummary) => void;
    readonly onPressPreview: (source: FilePreviewSource) => void;
    readonly onPressVideo: (attachment: ChatFileAttachment, sourceIdentifier: string) => void;
    readonly markdownLinkHandlers: MarkdownLinkHandlers;
    readonly renderMarkdownImage: MarkdownImageRenderer;
    readonly renderViewedImage: MarkdownImageRenderer;
    readonly renderReasoning: (text: string) => ReactNode;
    readonly iconSubtleColor: string | import("react-native").ColorValue;
    readonly screenColor: string;
    readonly userBubbleColor: string | import("react-native").ColorValue;
    readonly markdownStyles: MarkdownStyleSets;
    readonly reviewCommentColors: ReviewCommentColors;
    readonly reviewCommentBubbleWidth: number;
    readonly themeAppearance: "light" | "dark";
    readonly duoColumns: boolean;
    readonly userBubbleMaxWidth: number;
    readonly markdownContentWidth: number;
    readonly contentWidth: number;
    readonly threadTitle: string;
    readonly workflowOpening: WorkflowOpening | null;
  },
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props;

  if (entry.type === "guest-pending") {
    return (
      <ThreadGuestPendingMessage
        threadRef={scopeThreadRef(props.environmentId, props.threadId)}
        guestName={entry.guestName}
        message={entry.message}
        bubbleMaxWidth={props.duoColumns ? "85%" : props.userBubbleMaxWidth}
        renderAttachments={(attachments) => (
          <MessageAttachmentList
            attachments={attachments}
            environmentId={props.environmentId}
            onPressPreview={props.onPressPreview}
            onPressVideo={props.onPressVideo}
          />
        )}
      />
    );
  }

  if (entry.type === "run-fold") {
    return (
      <View className="mb-1 flex-row items-center border-b border-border-subtle px-2">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: entry.expanded }}
          onPress={() => props.onToggleTurnFold(entry.runId)}
          hitSlop={4}
          className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2"
          style={{
            minHeight: Math.max(TURN_FOLD_HEIGHT - 3.5, props.workRowSizing.estimatedRowHeight),
          }}
        >
          <Text
            key={props.workRowSizing.textSizeKey}
            numberOfLines={1}
            className="shrink font-t3-medium text-sm tabular-nums text-foreground-muted"
          >
            {entry.label}
          </Text>
          <ThreadDisclosureChevron
            expanded={entry.expanded}
            collapsedDirection="right"
            size={15}
            tintColor={iconSubtleColor}
          />
        </Pressable>
        {entry.checkpointSummary ? (
          <TurnDiffStat
            checkpoint={entry.checkpointSummary}
            onOpenTurnDiff={props.onOpenTurnDiff}
          />
        ) : null}
      </View>
    );
  }

  if (entry.type === "thinking") {
    return <ThreadThinkingRow rowSizing={props.workRowSizing} iconSubtleColor={iconSubtleColor} />;
  }

  if (entry.type === "html-render") {
    return (
      <ThreadHtmlRender
        environmentId={props.environmentId}
        threadId={props.threadId}
        render={entry.render}
        frameWidth={props.contentWidth}
        iconColor={iconSubtleColor}
      />
    );
  }

  if (entry.type === "mcp-app") {
    return (
      <ThreadMcpApp
        key={entry.app.attachmentId}
        environmentId={props.environmentId}
        threadId={entry.sourceThreadId}
        conversationThreadId={props.threadId}
        itemId={entry.itemId}
        revision={entry.revision}
        app={entry.app}
        width={props.contentWidth}
      />
    );
  }

  if (entry.type === "work-toggle") {
    return (
      <ThreadWorkGroupToggle
        environmentId={props.environmentId}
        rowSizing={props.workRowSizing}
        expanded={entry.expanded}
        hiddenCount={entry.hiddenCount}
        iconSubtleColor={iconSubtleColor}
        summary={entry.summary}
        summaryKind={entry.summaryKind}
        themeAppearance={props.themeAppearance}
        toolSurface={entry.toolSurface}
        toolIcon={entry.toolIcon}
        summaryToolIcon={entry.summaryToolIcon}
        hasFailure={entry.hasFailure}
        shimmer={entry.shimmer}
        thought={entry.thought}
        trailing={
          entry.checkpointSummary ? (
            <TurnDiffStat
              checkpoint={entry.checkpointSummary}
              onOpenTurnDiff={props.onOpenTurnDiff}
            />
          ) : null
        }
        onToggle={() => props.onToggleWorkGroup(entry.groupId, entry.id)}
      />
    );
  }

  if (entry.type === "activity-group" && isContextHandoffActivityGroup(entry)) {
    return (
      <ThreadHandoffRow
        environmentId={props.environmentId}
        projectedItem={entry.activities[0]!.projectedItem}
        iconColor={iconSubtleColor}
        surfaceColor={props.screenColor}
      />
    );
  }

  if (entry.type === "activity-group" && isSecretRequestActivityGroup(entry)) {
    return (
      <SecretRequestCard
        environmentId={props.environmentId}
        projectedItem={entry.activities[0]!.projectedItem}
        iconColor={iconSubtleColor}
      />
    );
  }

  if (entry.type === "activity-group" && isContextCompactionActivityGroup(entry)) {
    const label = entry.activities[0]!.summary;
    const item = entry.activities[0]!.projectedItem.item;
    const active =
      props.unsettledTurnId !== null &&
      entry.runId === props.unsettledTurnId &&
      item.status === "running";
    const labels = props.compactionLabelsByEntryId.get(entry.id);
    const failure =
      item.type === "compaction" && item.status === "failed" ? item.summary?.trim() : undefined;
    return (
      <ThreadContextDivider
        label={
          failure
            ? `${label} · ${failure}`
            : active && labels
              ? labels.compacting
              : compactionLabel(label, labels?.title)
        }
        icon={
          item.status === "failed" ? "exclamationmark.circle" : "arrow.down.right.and.arrow.up.left"
        }
        iconColor={iconSubtleColor}
        active={active}
        failed={item.status === "failed"}
      />
    );
  }

  if (entry.type === "message") {
    const { message } = entry;
    const isUser = message.role === "user";
    const presentation = resolveUserMessagePresentation(message);
    const renderedText = renderAssistantCitationsAsText(presentation.text);
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;
    const timestampLabel = formatMessageTime(isUser ? message.createdAt : message.updatedAt);
    const attachments = message.attachments ?? [];
    const hasReviewCommentContext = presentation.text.includes("<review_comment");
    // Android does not reposition children after maxWidth clamps bubbles; definite width prevents wide-block overlap.
    const hasWideBlock = hasWideMarkdownBlock(renderedText, WIDE_MARKDOWN_BLOCK_OPTIONS);
    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      props.unsettledTurnId !== null &&
      message.runId === props.unsettledTurnId;
    const showAssistantMeta =
      message.role === "assistant" &&
      props.terminalAssistantMessageIds.has(message.id) &&
      !assistantTurnStillInProgress &&
      !message.streaming;

    if (isUser && props.workflowOpening?.messageId === message.id) {
      return (
        <ThreadWorkflowOpening
          environmentId={props.environmentId}
          threadId={props.threadId}
          opening={props.workflowOpening}
        />
      );
    }
    if (isCompactionCommandFeedEntry(entry)) {
      // Stands in for the compaction item until the provider reports it.
      const active = props.unsettledTurnId !== null && message.runId === props.unsettledTurnId;
      const reason = idleCompactionOf(message);
      return (
        <ThreadContextDivider
          label={
            !active
              ? "Context compaction"
              : reason === undefined
                ? "Compacting context"
                : IDLE_COMPACTING_LABELS[reason]
          }
          icon="arrow.down.right.and.arrow.up.left"
          iconColor={iconSubtleColor}
          active={active}
        />
      );
    }
    if (isUser && presentation.attribution === "automation") {
      const rowId = `automation:${message.id}`;
      return (
        <ThreadAutomationMessageRow
          environmentId={props.environmentId}
          text={presentation.text}
          context={message.context}
          scheduledTaskId={presentation.scheduledTaskId}
          timestampLabel={timestampLabel}
          expanded={props.expandedWorkRows[rowId] ?? false}
          onToggle={() => props.onToggleWorkRow(rowId, entry.id)}
          bubbleColor={userBubbleColor}
          bubbleMaxWidth={props.duoColumns ? "85%" : props.userBubbleMaxWidth}
          contentMaxWidth={props.userBubbleMaxWidth - USER_BUBBLE_HORIZONTAL_PADDING * 2}
          iconSubtleColor={iconSubtleColor}
          markdownStyles={markdownStyles.user}
          reviewCommentColors={props.reviewCommentColors}
          skills={props.skills}
          linkHandlers={props.markdownLinkHandlers}
          renderImage={props.renderMarkdownImage}
        />
      );
    }
    if (isUser) {
      const enterAnimated = isFreshTimestamp(message.createdAt);
      const foldRowId = presentation.attribution === "agent" ? `agent:${message.id}` : null;
      const foldExpanded = foldRowId !== null && (props.expandedWorkRows[foldRowId] ?? false);
      const bubbleBodyVisible = foldRowId === null || foldExpanded;
      const intentBadge = resolveUserMessageIntentBadge(message.inputIntent);
      const referenceIds = new Set(
        collectComposerContextReferences(message.text).map((reference) => reference.contextId),
      );
      const inlineAttachmentIds = new Set(
        message.context?.records.flatMap((record) =>
          "attachmentId" in record && referenceIds.has(record.contextId)
            ? [record.attachmentId]
            : [],
        ),
      );
      const visibleAttachments = attachments.filter(
        (attachment) => isImageAttachment(attachment) || !inlineAttachmentIds.has(attachment.id),
      );
      return (
        <Animated.View
          className="mb-5 items-end"
          {...(enterAnimated ? { entering: FadeInUp.duration(220) } : {})}
        >
          {presentation.attribution === "t3code" ? (
            <Text className="mb-1 pr-1 font-t3-medium text-2xs text-foreground-muted opacity-60">
              Sent by T3 Code
            </Text>
          ) : null}
          {presentation.guestName !== undefined ? (
            <GuestMessageName name={presentation.guestName} />
          ) : null}
          <View
            className="min-w-0 rounded-[20px]"
            style={{
              backgroundColor: userBubbleColor,
              maxWidth: props.duoColumns ? "85%" : props.userBubbleMaxWidth,
              ...(!bubbleBodyVisible
                ? null
                : hasReviewCommentContext
                  ? { width: props.reviewCommentBubbleWidth }
                  : hasWideBlock || foldExpanded
                    ? { width: props.duoColumns ? "85%" : props.userBubbleMaxWidth }
                    : null),
            }}
          >
            {presentation.attribution === "guest" ? <GuestBubbleTint /> : null}
            {foldRowId !== null ? (
              <AgentMessageFoldHeader
                environmentId={props.environmentId}
                senderThreadId={message.senderThreadId}
                summary={
                  replaceComposerContextReferences(presentation.text, (ref) => ref.label)
                    .split(/\r?\n/)
                    .find((line) => line.trim().length > 0)
                    ?.trim() ?? ""
                }
                expanded={foldExpanded}
                onToggle={() => props.onToggleWorkRow(foldRowId, entry.id)}
                iconSubtleColor={iconSubtleColor}
              />
            ) : null}
            {bubbleBodyVisible ? (
              <View className={cn("gap-2 px-3.5 pb-2.5", foldRowId === null && "pt-2.5")}>
                {entry.pendingMessage?.attachments.map((attachment) =>
                  attachment.type === "image" && attachment.uploadedAttachmentId ? (
                    <MessageAttachmentImage
                      key={attachment.id}
                      environmentId={props.environmentId}
                      attachmentId={attachment.uploadedAttachmentId}
                      name={attachment.name}
                      mimeType={attachment.mimeType}
                      className="h-[140px] w-[180px] rounded-[14px]"
                      onPressPreview={props.onPressPreview}
                    />
                  ) : attachment.type === "image" ? (
                    <Pressable
                      key={attachment.id}
                      accessibilityRole="imagebutton"
                      accessibilityLabel={`Open ${attachment.name}`}
                      onPress={() =>
                        props.onPressPreview({
                          kind: "image",
                          name: attachment.name,
                          uri: attachment.dataUrl ?? attachment.previewUri,
                          gallery: composerImageGallery(entry.pendingMessage?.attachments ?? []),
                        })
                      }
                    >
                      <Image
                        source={{ uri: attachment.previewUri }}
                        style={{ width: 180, height: 140, borderRadius: 14 }}
                      />
                    </Pressable>
                  ) : (
                    <MessageAttachmentUnknown key={attachment.id} name={attachment.name} />
                  ),
                )}
                {/* An empty container still takes a gap, which pads every attachment-free bubble. */}
                {visibleAttachments.length > 0 ? (
                  <View className={inlineAttachmentIds.size ? "flex-row flex-wrap gap-2" : "gap-2"}>
                    {visibleAttachments.map((attachment) => {
                      return isImageAttachment(attachment) ? (
                        <MessageAttachmentImage
                          key={attachment.id}
                          environmentId={props.environmentId}
                          attachmentId={attachment.id}
                          name={attachment.name}
                          mimeType={attachment.mimeType}
                          className={
                            inlineAttachmentIds.size
                              ? "h-24 w-24 rounded-[14px] bg-user-bubble-foreground/15"
                              : "aspect-[1.3] w-full rounded-[14px] bg-user-bubble-foreground/15"
                          }
                          onPressPreview={props.onPressPreview}
                        />
                      ) : isFileAttachment(attachment) ? (
                        <MessageAttachmentFile
                          key={attachment.id}
                          environmentId={props.environmentId}
                          attachment={attachment}
                          onPressPreview={props.onPressPreview}
                          onPressVideo={props.onPressVideo}
                        />
                      ) : (
                        <MessageAttachmentUnknown key={attachment.id} name={attachment.name} />
                      );
                    })}
                  </View>
                ) : null}
                {message.text.trim().length > 0 ? (
                  <MarkdownImageAvailableWidthContext
                    value={props.userBubbleMaxWidth - USER_BUBBLE_HORIZONTAL_PADDING * 2}
                  >
                    <UserMessageContent
                      text={renderedText}
                      environmentId={props.environmentId}
                      context={message.context}
                      markdownStyles={styles}
                      reviewCommentColors={props.reviewCommentColors}
                      skills={props.skills}
                      linkHandlers={props.markdownLinkHandlers}
                      renderImage={props.renderMarkdownImage}
                    />
                  </MarkdownImageAvailableWidthContext>
                ) : null}
              </View>
            ) : null}
          </View>
          {bubbleBodyVisible ? (
            <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
              {foldRowId !== null && message.senderThreadId ? (
                <OpenSenderThreadButton
                  environmentId={props.environmentId}
                  senderThreadId={message.senderThreadId}
                />
              ) : null}
              {intentBadge ? (
                <View
                  accessible
                  accessibilityLabel={intentBadge.accessibilityLabel}
                  className="flex-row items-center gap-1"
                >
                  <SymbolView name="arrow.uturn.forward" size={12} tintColor={iconSubtleColor} />
                  <Text className="font-t3-medium text-xs text-foreground-secondary">
                    {intentBadge.label}
                  </Text>
                </View>
              ) : null}
              {intentBadge ? (
                <Text
                  accessible={false}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                  className="font-t3-medium text-xs text-foreground-secondary"
                >
                  ·
                </Text>
              ) : null}
              <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
                {entry.pendingMessage && !entry.acknowledged ? "Pending" : timestampLabel}
              </Text>
              {props.onEditPendingMessage !== null &&
              entry.pendingMessage &&
              !entry.acknowledged &&
              !entry.pendingMessage.creation &&
              entry.pendingMessage.messageId !== props.dispatchingMessageId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Edit pending message"
                  hitSlop={8}
                  className="size-7 items-center justify-center"
                  onPress={() => {
                    if (entry.pendingMessage && props.onEditPendingMessage) {
                      props.onEditPendingMessage(entry.pendingMessage);
                    }
                  }}
                >
                  <SymbolView name="pencil" size={14} tintColor={iconSubtleColor} />
                </Pressable>
              ) : null}
              {presentation.text.trim().length > 0 ? (
                <UserMessageCopyButton
                  text={presentation.text}
                  onCopy={
                    message.context && presentation.attribution !== "guest"
                      ? () =>
                          writeComposerContextClipboard(message.text, {
                            version: 1,
                            source: { environmentId: props.environmentId, messageId: message.id },
                            records: message.context!.records,
                          })
                      : undefined
                  }
                  tintColor={iconSubtleColor}
                />
              ) : null}
            </View>
          ) : null}
        </Animated.View>
      );
    }

    if (renderedText.trim().length === 0 && attachments.length === 0) {
      return null;
    }

    const enterAnimated = isFreshTimestamp(message.createdAt);
    return (
      <Animated.View
        className={cn(
          showAssistantMeta && !(message.runId && props.failedRunIds.has(message.runId))
            ? "mb-5 px-1"
            : "mb-1 px-1",
          hasWideBlock && "w-full",
        )}
        {...(enterAnimated ? { entering: FadeIn.duration(220) } : {})}
      >
        {renderedText.trim().length > 0 ? (
          <MarkdownImageAvailableWidthContext value={props.markdownContentWidth}>
            <AssistantMarkdownContent
              markdown={renderedText}
              environmentId={props.environmentId}
              markdownStyles={styles}
              linkHandlers={props.markdownLinkHandlers}
              onUseArtifactTemplate={props.onUseArtifactTemplate}
              renderImage={props.renderMarkdownImage}
              skills={props.skills}
            />
          </MarkdownImageAvailableWidthContext>
        ) : null}
        <MessageAttachmentList
          attachments={attachments}
          environmentId={props.environmentId}
          onPressPreview={props.onPressPreview}
          onPressVideo={props.onPressVideo}
        />
        {showAssistantMeta && message.checkpointSummary ? (
          <TurnDiffStat
            checkpoint={message.checkpointSummary}
            onOpenTurnDiff={props.onOpenTurnDiff}
          />
        ) : null}
        {showAssistantMeta ? (
          <View className="mt-1 flex-row items-center gap-1">
            <CopyTextButton
              accessibilityLabel="Copy message"
              text={renderedText}
              tintColor={iconSubtleColor}
              buttonSize={28}
              iconSize={13}
            />
            {message.projectedItem ? (
              <AssistantForkButton
                environmentId={props.environmentId}
                iconColor={iconSubtleColor}
                projectedItem={message.projectedItem}
                sourceTitle={props.threadTitle}
              />
            ) : null}
            <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
              {timestampLabel}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    );
  }

  return (
    <ThreadWorkLog
      key={`${entry.id}:${props.workRowSizing.textSizeKey}`}
      activities={entry.activities}
      continuesWorkLog={entry.continuesWorkLog}
      environmentId={props.environmentId}
      workspaceRoot={props.workspaceRoot}
      anchorKey={entry.id}
      copiedRowId={props.copiedRowId}
      expandedRows={props.expandedWorkRows}
      rowSizing={props.workRowSizing}
      scrollPositions={props.workGroupScrollPositions}
      iconSubtleColor={iconSubtleColor}
      edgeFadeColor={props.screenColor}
      themeAppearance={props.themeAppearance}
      onCopyRow={props.onCopyWorkRow}
      onToggleRow={props.onToggleWorkRow}
      renderImage={props.renderViewedImage}
      renderReasoning={props.renderReasoning}
      onPressPreview={props.onPressPreview}
    />
  );
}

function TurnDiffStat(props: {
  readonly checkpoint: ThreadCheckpointSummary;
  readonly onOpenTurnDiff: (checkpoint: ThreadCheckpointSummary) => void;
}) {
  const { files } = props.checkpoint;
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const fileCountLabel = `${files.length} file${files.length === 1 ? "" : "s"} changed`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Review ${fileCountLabel}, ${additions} additions, ${deletions} deletions`}
      onPress={() => props.onOpenTurnDiff(props.checkpoint)}
      className="min-h-11 shrink-0 flex-row items-center gap-2 px-2 active:bg-subtle"
    >
      <Text className="font-t3-medium text-xs tabular-nums text-adaptive-emerald-700-300">
        +{formatDiffCount(additions)}
      </Text>
      <Text className="font-t3-medium text-xs tabular-nums text-adaptive-rose-700-300">
        −{formatDiffCount(deletions)}
      </Text>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-foreground-muted" />
    </Pressable>
  );
}

type UserMessageContentProps = {
  readonly text: string;
  readonly environmentId: EnvironmentId;
  readonly context?: OrchestrationMessageContext;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly renderImage: MarkdownImageRenderer;
};

function UserMessageContent(props: UserMessageContentProps) {
  const [selected, setSelected] = useState<{ contextId: string; label: string } | null>(null);
  const navigation = useNavigation();
  const openLinkedThread = useOpenLinkedThread();
  const { selectedThread } = useThreadSelection();
  const liveText = useLiveThreadLinkLabels(props.text, props.environmentId);
  const threadIcons = useThreadChipIcons(props.environmentId, liveText, props.context?.records);
  const text = replaceComposerContextReferences(liveText, (ref) => {
    const available = props.context?.records.some((record) => record.contextId === ref.contextId);
    return `[${ref.label}${available ? "" : " (unavailable)"}](t3-context://v1/${ref.kind}/${ref.contextId})`;
  });
  const onLinkPress = (href: string) => {
    const reference = parseComposerContextHref(href);
    if (!reference) return props.linkHandlers.onLinkPress?.(href);
    const record = props.context?.records.find(
      (record) => record.contextId === reference.contextId,
    );
    if (record?.kind === "mention" && "path" in record) {
      props.linkHandlers.onLinkPress?.(record.path);
      return;
    }
    if (record?.kind === "thread" && "threadId" in record) {
      openLinkedThread({
        environmentId: String(record.environmentId),
        threadId: String(record.threadId),
      });
      return;
    }
    const document = composerDocumentAttachmentRecord(record);
    if (document) {
      navigation.navigate("ThreadAttachment", {
        environmentId: String(props.environmentId),
        ...(selectedThread ? { threadId: String(selectedThread.id) } : {}),
        attachmentId: document.attachmentId,
        name: document.name,
        mimeType: document.mimeType,
        sizeBytes: String(document.sizeBytes),
      });
      return;
    }
    setSelected({ contextId: reference.contextId, label: record?.label ?? "Context unavailable" });
  };
  return (
    <>
      <UserMessageMarkdownContent
        {...props}
        text={text}
        linkHandlers={{
          ...props.linkHandlers,
          onLinkPress,
          fileContextMenu: (href) => {
            const reference = parseComposerContextHref(href);
            if (!reference) return props.linkHandlers.fileContextMenu(href);
            const record = props.context?.records.find(
              (item) => item.contextId === reference.contextId,
            );
            return {
              title: record?.label ?? "Context unavailable",
              actions: [
                { id: "open-context", title: "Open context" },
                { id: "copy-context", title: "Copy context", disabled: !record },
              ],
            };
          },
          onFileContextMenuAction: (href, actionId) => {
            const reference = parseComposerContextHref(href);
            if (!reference) return props.linkHandlers.onFileContextMenuAction(href, actionId);
            if (actionId === "open-context") return onLinkPress(href);
            const record = props.context?.records.find(
              (item) => item.contextId === reference.contextId,
            );
            if (actionId === "copy-context" && record) {
              void writeComposerContextClipboard(
                formatComposerContextReference({
                  ...reference,
                  label: record.label,
                }),
                {
                  version: 1,
                  source: { environmentId: props.environmentId },
                  records: [record],
                },
              )
                .then(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success))
                .catch(() => {
                  Dialog.alert("Could not copy context", "Try copying this context again.");
                });
            }
          },
          linkCustomization: (href) =>
            withChipIcon(
              enrichedContextLinkCustomization(href, props.context?.records ?? []) ??
                props.linkHandlers.linkCustomization?.(href),
              threadIcons.get(href),
            ),
        }}
      />
      {selected ? (
        <ComposerContextSheet
          label={selected.label}
          environmentId={props.environmentId}
          records={props.context?.records}
          record={props.context?.records.find((record) => record.contextId === selected.contextId)}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function UserMessageMarkdownContent(props: UserMessageContentProps) {
  const text = props.text;
  const segments = parseReviewCommentMessageSegments(text);
  const hasReviewComment = segments.some((segment) => segment.kind === "review-comment");
  const contextClipboardFragment = props.context
    ? (encodeComposerContextFragment({
        version: 1,
        source: { environmentId: props.environmentId },
        records: props.context.records,
      }) ?? undefined)
    : undefined;
  if (!hasReviewComment) {
    return (
      <SelectableMarkdownText
        markdown={text}
        contextClipboardFragment={contextClipboardFragment}
        skills={props.skills}
        textStyle={props.markdownStyles.nativeTextStyle}
        preserveSoftBreaks
        {...props.linkHandlers}
        renderImage={props.renderImage}
      />
    );
  }

  return (
    <View className="w-full gap-2">
      {segments.map((segment) => {
        if (segment.kind === "review-comment") {
          return (
            <ReviewCommentCard
              key={segment.comment.id}
              comment={segment.comment}
              colors={props.reviewCommentColors}
            />
          );
        }

        const text = segment.text.trim();
        if (text.length === 0) {
          return null;
        }

        return (
          <SelectableMarkdownText
            key={segment.id}
            markdown={text}
            contextClipboardFragment={contextClipboardFragment}
            skills={props.skills}
            textStyle={props.markdownStyles.nativeTextStyle}
            preserveSoftBreaks
            {...props.linkHandlers}
            renderImage={props.renderImage}
          />
        );
      })}
    </View>
  );
}

function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number;
  readonly detail: string;
  readonly horizontalPadding: number;
  readonly title: string;
  readonly topInset: number;
}) {
  return (
    <View
      style={{
        flex: 1,
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: props.horizontalPadding + 24,
      }}
    >
      <View className="max-w-[320px] items-center gap-2">
        <Text className="text-center font-t3-bold text-lg text-foreground">{props.title}</Text>
        <Text className="text-center text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      </View>
    </View>
  );
}

// A hook's return value is frozen to the compiler, so ThreadFeed's later
// hooks can't drag this derivation into an uncached scope.
function useThreadFeedPresentation(
  props: ThreadFeedProps,
  expandedTurnIds: ReadonlySet<RunId>,
  expandedWorkGroups: Record<string, boolean>,
) {
  const [feedCache] = useState(createThreadFeedCache);
  return appendPendingThreadMessages(
    deriveThreadFeedPresentation(
      props.feed,
      props.latestRun,
      expandedTurnIds,
      new Set(
        Object.entries(expandedWorkGroups)
          .filter(([, expanded]) => expanded)
          .map(([groupId]) => groupId),
      ),
      props.activeWorkStartedAt,
      props.runlessWorkActive ?? false,
      feedCache,
    ),
    props.feed,
    props.queuedMessages,
  );
}

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const { listRef, onEndFollowEnabledChange, onHeaderMaterialVisibilityChange } = props;
  const workflowOpening = useWorkflowOpening(props.environmentId, props.threadId);
  const guestThreadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const guestShare = useThreadGuestShare(guestThreadRef);
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
  const previousLatestTurnRef = useRef(props.latestRun);
  const userScrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headerMaterialVisibleRef = useRef(false);
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const { appearance } = useAppearancePreferences();
  const workRowSizing = deriveThreadWorkLogSizing({
    baseFontSize: appearance.baseFontSize,
    fontScale,
  });
  const previousTextSize = useRef(workRowSizing.textSizeKey);
  useLayoutEffect(() => {
    if (previousTextSize.current === workRowSizing.textSizeKey) {
      return;
    }
    previousTextSize.current = workRowSizing.textSizeKey;
    listRef.current?.clearCaches({ mode: "sizes" });
  }, [workRowSizing.textSizeKey, listRef]);
  const settledPaneWidth = useWorkspaceSettledContentWidth();
  const [measuredViewportWidth, setViewportWidth] = useState(() =>
    props.layoutVariant === "split" ? 0 : windowWidth,
  );
  const viewportWidth =
    settledPaneWidth !== null ? Math.round(settledPaneWidth) : measuredViewportWidth;
  const [viewportHeight, setViewportHeight] = useState(0);
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
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
  const [reflowSettleRevision, setReflowSettleRevision] = useState(0);
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
  const [expandedFile, setExpandedFile] = useState<FilePreviewSource | null>(null);
  const [expandedVideo, setExpandedVideo] = useState<VideoPreviewSource | null>(null);
  const markdownLinkRequest = useRef<AbortController | null>(null);
  useFocusEffect(useCallback(() => () => markdownLinkRequest.current?.abort(), []));
  const markdownLinkScope = JSON.stringify([
    props.environmentId,
    props.threadId,
    props.contentPresentation.kind,
  ]);
  const previousMarkdownLinkScope = useRef(markdownLinkScope);
  useLayoutEffect(() => {
    if (previousMarkdownLinkScope.current === markdownLinkScope) return;
    previousMarkdownLinkScope.current = markdownLinkScope;
    markdownLinkRequest.current?.abort();
  }, [markdownLinkScope]);
  const fileShareSourceIdentifier = useId();
  const shareFileChip = useFileChipShare(
    props.environmentId,
    props.threadId,
    fileShareSourceIdentifier,
  );
  useEffect(() => {
    setExpandedVideo(null);
    setExpandedFile(null);
  }, [props.environmentId, props.threadId, props.contentPresentation.kind]);
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
  const screenColor = theme["--color-screen"];
  const userBubbleColor = theme["--color-user-bubble"];
  const openSkillInstructions = (path: string) => {
    void Haptics.selectionAsync();
    navigation.navigate("ThreadFile", {
      environmentId: String(props.environmentId),
      threadId: String(props.threadId),
      path: fileRoutePathSegments(path),
    });
  };
  const resolveLinkedThread = (href: string) => {
    const linkedThreadId = parseThreadLinkHref(href);
    if (!linkedThreadId) return null;
    const source = scopeThreadRef(props.environmentId, linkedThreadId);
    return (
      resolveThreadLinkRef(source, appAtomRegistry.get(environmentThreadShells.threadRefsAtom)) ??
      source
    );
  };
  const onMarkdownLinkPress = (href: string, imageEmbed = false) => {
    markdownLinkRequest.current?.abort();
    const request = new AbortController();
    markdownLinkRequest.current = request;
    const skill = enrichedSkillReference(href, props.skills);
    if (skill) {
      const instructionsPath = enrichedSkillInstructionsPath(skill);
      if (instructionsPath) openSkillInstructions(instructionsPath);
      return;
    }
    const target = resolveLinkedThread(href);
    if (target) {
      openLinkedThread({
        environmentId: String(target.environmentId),
        threadId: String(target.threadId),
      });
      return;
    }
    const media = resolveMarkdownMediaPreview(href, {
      environmentId: props.environmentId,
      threadId: props.threadId,
      workspaceRoot: props.workspaceRoot,
      imageEmbed,
    });
    if (media) {
      void Haptics.selectionAsync();
      const openPreview = () => {
        if (request.signal.aborted) return;
        if (media.kind === "video") {
          setExpandedVideo((current) => current ?? media.source);
        } else {
          setExpandedFile((current) => current ?? media.source);
        }
      };
      const resource = "resource" in media.source ? media.source.resource : null;
      const mediaPath = resource && "path" in resource ? resource.path : null;
      if (
        typeof mediaPath === "string" &&
        readEnvironmentScope(props.environmentId, AuthFilesystemReadScope)
      ) {
        void executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.fileMetadata({
            environmentId: props.environmentId,
            input: { path: mediaPath },
          }),
          { signal: request.signal, reportFailure: false, reportDefect: false },
        ).then((result) => {
          if (request.signal.aborted) return;
          if (result._tag === "Success" && result.value?.kind === "directory") {
            navigation.navigate("ThreadFile", {
              environmentId: String(props.environmentId),
              threadId: String(props.threadId),
              path: fileRoutePathSegments(mediaPath),
            });
          } else openPreview();
        }, openPreview);
      } else openPreview();
      return;
    }

    const presentation = resolveMarkdownLinkPresentation(href);
    if (presentation.kind === "file") {
      const path = resolveFileLinkPath(props.workspaceRoot, presentation.path);
      if (path === null) return;
      const relativePath = resolveWorkspaceRelativeFilePath(props.workspaceRoot, path);
      const openAt = (target: string) => {
        if (request.signal.aborted) return;
        void Haptics.selectionAsync();
        navigation.navigate("ThreadFile", {
          environmentId: String(props.environmentId),
          threadId: String(props.threadId),
          path: fileRoutePathSegments(target),
          ...(presentation.line ? { line: String(presentation.line) } : {}),
        });
      };
      if (
        props.workspaceRoot &&
        relativePath &&
        !/[\\/]$/.test(presentation.path) &&
        needsWorkspaceBasenameLookup(relativePath) &&
        readEnvironmentScope(props.environmentId, AuthFilesystemReadScope)
      ) {
        const originalPath = resolveWorkspaceFilePath(props.workspaceRoot, relativePath);
        void executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.searchEntries({
            environmentId: props.environmentId,
            input: {
              cwd: props.workspaceRoot,
              query: relativePath,
              kind: "file",
              limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
            },
          }),
          { signal: request.signal, reportFailure: false, reportDefect: false },
        ).then(
          (result) => {
            const match =
              result._tag === "Success"
                ? pickWorkspaceBasenameMatch(relativePath, result.value.entries)
                : null;
            if (!match || match === relativePath) {
              openAt(relativePath);
              return;
            }
            if (request.signal.aborted) return;
            void executeAtomQuery(
              appAtomRegistry,
              projectEnvironment.fileMetadata({
                environmentId: props.environmentId,
                input: { path: originalPath },
              }),
              { signal: request.signal, reportFailure: false, reportDefect: false },
            ).then(
              (metadata) =>
                openAt(
                  metadata._tag === "Success" && metadata.value?.kind !== "directory"
                    ? match
                    : relativePath,
                ),
              () => openAt(relativePath),
            );
          },
          () => openAt(relativePath),
        );
      } else openAt(relativePath ?? path);
      return;
    }

    if (presentation.href) {
      if (/^https?:\/\//i.test(presentation.href) && isPdfFile({ name: presentation.href })) {
        setExpandedFile(
          (current) => current ?? { kind: "pdf", uri: presentation.href!, name: "Document.pdf" },
        );
        return;
      }
      void openPullRequest(presentation.href);
    }
  };
  const resolveImageSource = useMarkdownImageSource({
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: props.workspaceRoot ?? null,
  });
  const markdownLinkHandlers: MarkdownLinkHandlers = {
    onLinkPress: onMarkdownLinkPress,
    linkCustomization: enrichedThreadLinkCustomization,
    onImagePress: (href) => onMarkdownLinkPress(href, true),
    resolveImageSource,
    fileContextMenu: (href) => {
      const skill = enrichedSkillReference(href, props.skills);
      if (skill) {
        return {
          title: enrichedSkillDisplayName(skill),
          actions: [
            {
              id: "open-skill",
              title: "View instructions",
              disabled: !enrichedSkillInstructionsPath(skill),
            },
            { id: "copy-skill", title: "Copy skill" },
          ],
        };
      }
      const thread = resolveLinkedThread(href);
      if (thread) {
        return {
          title:
            appAtomRegistry.get(environmentThreadShells.threadShellAtom(thread))?.title ?? "Thread",
          actions: [
            { id: "open-thread", title: "Open thread" },
            { id: "copy-thread-link", title: "Copy link" },
          ],
        };
      }
      const target = resolveFileChipTarget(href, props.workspaceRoot);
      return target ? fileChipMenu(target) : undefined;
    },
    onFileContextMenuAction: (href, actionId) => {
      const skill = enrichedSkillReference(href, props.skills);
      if (skill) {
        const instructionsPath = enrichedSkillInstructionsPath(skill);
        if (actionId === "open-skill" && instructionsPath) openSkillInstructions(instructionsPath);
        else if (actionId === "copy-skill") copyTextWithHaptic(`$${skill.name}`);
        return;
      }
      if (resolveLinkedThread(href)) {
        if (actionId === "open-thread") onMarkdownLinkPress(href);
        else if (actionId === "copy-thread-link") copyTextWithHaptic(href);
        return;
      }
      const target = resolveFileChipTarget(href, props.workspaceRoot);
      if (!target) return;
      switch (actionId) {
        case "copy-full-path":
        case "copy-relative-path": {
          const clipboardPath = fileChipClipboardPath(target, actionId);
          if (clipboardPath !== undefined) copyTextWithHaptic(clipboardPath);
          return;
        }
        case "open-file":
          onMarkdownLinkPress(href);
          return;
        case "save":
          shareFileChip(target);
          return;
      }
    },
  };
  const renderMarkdownImage: MarkdownImageRenderer = (image) => {
    const media = resolveMarkdownMediaPreview(image.href, {
      environmentId: props.environmentId,
      threadId: props.threadId,
      workspaceRoot: props.workspaceRoot,
      imageEmbed: true,
    });
    if (media?.kind === "video") {
      return (
        <ThreadMarkdownVideo
          key={image.href}
          source={{ ...media.source, name: image.alt ?? media.source.name }}
        />
      );
    }
    const imageSource = classifyMarkdownImageSource(image.href, props.workspaceRoot ?? null);
    if (imageSource._tag === "Direct") {
      return (
        <ThreadMarkdownImageView
          uri={normalizeNativeMarkdownUrl(imageSource.uri)}
          sourceKey={imageSource.uri}
          format={
            /\.svg(?:[?#]|$)/i.test(imageSource.uri) ||
            imageSource.uri.startsWith("data:image/svg+xml")
              ? "svg"
              : undefined
          }
          unavailable={false}
          alt={image.alt}
          actionsSource={media?.source.actionsSource}
          onPressPreview={onPressPreview}
        />
      );
    }
    if (imageSource._tag === "Blocked") {
      return <ThreadMarkdownImageUnavailable alt={image.alt} />;
    }
    return (
      <ThreadMarkdownImage
        environmentId={props.environmentId}
        resource={{
          _tag: "media-file",
          threadId: props.threadId,
          path: imageSource.path,
        }}
        alt={image.alt}
        srcFragment={markdownImageSourceFragment(image.href)}
        actionsSource={media?.source.actionsSource}
        onPressPreview={onPressPreview}
      />
    );
  };
  const renderViewedImage: MarkdownImageRenderer = (image) => {
    const viewedImage = resolveViewedImageAsset(image.href, {
      threadId: props.threadId,
      workspaceRoot: props.workspaceRoot,
    });
    const media = viewedImage
      ? resolveMarkdownMediaPreview(image.href, {
          environmentId: props.environmentId,
          threadId: props.threadId,
          workspaceRoot: props.workspaceRoot,
          imageEmbed: true,
        })
      : null;
    const actionsSource = media?.source.actionsSource;
    return viewedImage ? (
      <ThreadMarkdownImage
        environmentId={props.environmentId}
        resource={viewedImage.resource}
        alt={viewedImage.alt}
        srcFragment={viewedImage.srcFragment}
        actionsSource={
          actionsSource && "resource" in actionsSource
            ? { ...actionsSource, resource: viewedImage.resource }
            : undefined
        }
        onPressPreview={onPressPreview}
      />
    ) : null;
  };
  const markdownStyles = useMarkdownStyles();
  const renderReasoning = (text: string) => (
    <AssistantMarkdownContent
      markdown={text}
      environmentId={props.environmentId}
      markdownStyles={markdownStyles.assistant}
      linkHandlers={markdownLinkHandlers}
      renderImage={renderMarkdownImage}
      skills={props.skills}
    />
  );
  const reviewCommentColors = useReviewCommentColors();
  const unsettledTurnId = threadFeedRunIsUnsettled(props.latestRun) ? props.latestRun.runId : null;
  const compactionLabelsByEntryId = useMemo(
    () => threadFeedCompactionLabels(props.feed),
    [props.feed],
  );
  // LegendList does not invalidate visible rows when only the renderItem closure changes.
  // Include turn completion so unchanged message rows reveal their footer and spacing
  // even when the final message update arrives before the turn settles.
  const listAppearanceData = {
    worktreeSetup: props.worktreeSetup,
    setupWorkingStartedAt: props.setupWorkingStartedAt,
    dispatchingMessageId: props.dispatchingMessageId,
    unsettledTurnId,
    copiedRowId,
    expandedWorkGroups,
    expandedWorkRows,
    workRowSizing,
    iconSubtleColor,
    markdownStyles,
    reviewCommentColors,
    themeAppearance,
    userBubbleColor,
    viewportWidth,
    contentWidth,
    skills: props.skills,
    workflowOpening,
  };
  const reportHeaderMaterialVisibility = (visible: boolean) => {
    if (headerMaterialVisibleRef.current === visible) {
      return;
    }
    headerMaterialVisibleRef.current = visible;
    onHeaderMaterialVisibilityChange?.(visible);
  };
  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    reportHeaderMaterialVisibility(event.nativeEvent.contentOffset.y + anchorTopInset > 6);
    // Re-arm follow only at the actual end; the broader threshold can reclaim upward drags during streaming.
    const listState = listRef.current?.getState();
    if (listState) {
      transitionEndFollow({
        type: "scroll",
        isAtEnd: listState.isAtEnd,
        userScrollSessionActive: userScrollSessionRef.current,
      });
    }
  };
  const clearUserScrollSettle = () => {
    if (userScrollSettleTimerRef.current !== null) {
      clearTimeout(userScrollSettleTimerRef.current);
      userScrollSettleTimerRef.current = null;
    }
  };
  const handleScrollBeginDrag = () => {
    clearUserScrollSettle();
    userScrollSessionRef.current = true;
    cancelReflow();
    // Pause before the first scroll event. Otherwise a stream update can run
    // maintainScrollAtEnd between touch-down and the drag leaving its threshold.
    transitionEndFollow({ type: "user-scroll-begin" });
  };
  const finishUserScroll = (releaseIsAtEnd?: boolean) => {
    clearUserScrollSettle();
    const userScrollSessionActive = userScrollSessionRef.current;
    userScrollSessionRef.current = false;
    transitionEndFollow({
      type: "user-scroll-end",
      // Without momentum, retain release position; stream growth during detection must not disable follow.
      isAtEnd: releaseIsAtEnd ?? listRef.current?.getState().isAtEnd ?? false,
      userScrollSessionActive,
    });
  };
  // Zero release velocity may still produce momentum; wait for native detection before ending the session.
  const handleScrollEndDrag = () => {
    clearUserScrollSettle();
    const releaseIsAtEnd = listRef.current?.getState().isAtEnd ?? false;
    userScrollSettleTimerRef.current = setTimeout(() => finishUserScroll(releaseIsAtEnd), 160);
  };
  const handleMomentumScrollBegin = () => {
    if (userScrollSessionRef.current) {
      clearUserScrollSettle();
    }
  };
  const handleMomentumScrollEnd = () => {
    finishUserScroll();
  };

  useEffect(() => clearUserScrollSettle, [clearUserScrollSettle]);

  const feedThreadKey = scopedThreadKey(props.environmentId, props.threadId);
  const workGroupScrollPositions = new Map<string, ThreadWorkGroupScrollPosition>();
  // Only a new thread or a send resets following. Listed as dependencies, these handlers also ran
  // whenever a parent passed a new follow callback, as a fold does: following re-armed under a
  // reader and a width reflow lost its place mid-fold.
  const resetEndFollow = useEffectEvent((_trigger: unknown) => {
    clearUserScrollSettle();
    userScrollSessionRef.current = false;
    cancelReflow();
    transitionEndFollow({ type: "reset" });
  });
  useEffect(() => resetEndFollow(feedThreadKey), [feedThreadKey]);
  useEffect(() => {
    if (props.submittedMessageId !== null) resetEndFollow(props.submittedMessageId);
  }, [props.submittedMessageId]);

  useEffect(() => {
    reportHeaderMaterialVisibility(false);
  }, [feedThreadKey, reportHeaderMaterialVisibility]);

  const presentedFeed = appendGuestPendingMessages(
    useThreadFeedPresentation(props, expandedTurnIds, expandedWorkGroups),
    guestShare,
  );
  const setupAnchorIndex = presentedFeed.findIndex(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  // Empty/filled remounts reset imperative insets; seed the overlay first. Android uses a declarative inset floor.
  const listMountKey = `${feedThreadKey}:${presentedFeed.some((entry) => entry.type !== "thinking") ? "filled" : "empty"}`;
  useLayoutEffect(() => {
    const bottom = props.contentInsetEndAdjustment.value;
    if (bottom > 0) {
      listRef.current?.reportContentInset({ bottom });
    }
  }, [listMountKey, props.contentInsetEndAdjustment, listRef]);
  // Opening at a message: its run unfolds, the list stops following the end
  // (a render later, so the end does not pull it back), then it scrolls there.
  const [loadedListKey, setLoadedListKey] = useState<string | null>(null);
  const { jumpToMessageId } = props;
  const finishJump = useEffectEvent(() => props.onJumpedToMessage?.());
  const stopFollowingEnd = useEffectEvent(() => setEndFollow(false));
  useEffect(() => {
    if (!jumpToMessageId || loadedListKey !== listMountKey) return;
    const index = presentedFeed.findIndex(
      (entry) => entry.type === "message" && entry.id === jumpToMessageId,
    );
    if (index === -1) {
      const runId = messageFoldRunId(props.feed, jumpToMessageId);
      if (runId && !expandedTurnIds.has(runId)) {
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(runId),
        }));
      } else {
        finishJump();
      }
      return;
    }
    if (endFollowEnabled) {
      stopFollowingEnd();
      return;
    }
    void listRef.current?.scrollToIndex({ index, viewPosition: 0.2, animated: false });
    finishJump();
  }, [
    endFollowEnabled,
    expandedTurnIds,
    jumpToMessageId,
    listMountKey,
    listRef,
    loadedListKey,
    presentedFeed,
    props.feed,
  ]);

  const reflowLayout = () => ({
    rowsTop: FEED_PADDING_TOP + listHeaderSizeRef.current,
    headerInset: anchorTopInset,
  });
  const beginReflow = () => {
    // Until the list loads, its own initial end positioning owns the offset.
    if (loadedListKeyRef.current !== listMountKey) return;
    if (reflowAnchorRef.current === undefined) {
      const listState = listRef.current?.getState();
      const anchor =
        listState && !userScrollSessionRef.current
          ? resolveThreadFeedReflowAnchor(listState, reflowLayout(), endFollowEnabledRef.current)
          : null;
      reflowAnchorRef.current = anchor;
      if (anchor === "end" && !reflowAnchorsSizeChanges) {
        // The list may already have judged the first new sizes against its own threshold, so
        // pin the end once; the lifted threshold keeps it there as later rows re-measure.
        setReflowFollowsEnd(true);
        void listRef.current?.scrollToEnd({ animated: false });
      }
    }
    setReflowSettleRevision((revision) => revision + 1);
  };
  const settleReflow = useEffectEvent(() => {
    const anchor = reflowAnchorRef.current;
    cancelReflow();
    const list = listRef.current;
    if (reflowAnchorsSizeChanges || !anchor || anchor === "end" || !list) return;
    if (userScrollSessionRef.current) return;
    if (loadedListKeyRef.current !== listMountKey) return;
    const target = resolveThreadFeedReflowScroll(anchor, list.getState(), reflowLayout());
    if (target) void list.scrollToIndex({ ...target, viewPosition: 0, animated: false });
  });
  useEffect(() => {
    if (reflowSettleRevision === 0) return;
    const timeout = setTimeout(
      () => settleReflow(),
      reflowAnchorsSizeChanges ? FEED_REFLOW_HOLD_MS : FEED_REFLOW_SETTLE_MS,
    );
    return () => clearTimeout(timeout);
  }, [reflowSettleRevision]);

  const holdReflowAnchor = () => {
    const anchor = reflowAnchorRef.current;
    if (anchor === "end") return Number.POSITIVE_INFINITY;
    const list = listRef.current;
    return anchor && list
      ? resolveThreadFeedReflowOffset(anchor, list.getState(), reflowLayout())
      : undefined;
  };

  const handleViewportLayout = (event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    // A native resize re-wraps the rows before JS hears of it. This event reaches JS ahead
    // of the row measurements it caused, since layout events are sent parent first.
    if (Math.abs(measuredViewportWidth - nextWidth) > 1) beginReflow();
    setViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
    setViewportHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
  };

  const anchoredEndSpace = resolveChatListAnchoredEndSpace(
    presentedFeed,
    props.anchorMessageId,
    (entry) => (entry.type === "message" ? entry.id : null),
    { anchorOffset: anchorTopInset + CHAT_LIST_ANCHOR_OFFSET },
  );
  const failedRunIds = failedFeedRunIds(props.feed, props.latestRun);
  const terminalAssistantMessageIds = (() => {
    const terminalIdsByTurn = new Map<RunId, string>();
    for (const entry of props.feed) {
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.runId) {
        terminalIdsByTurn.set(entry.message.runId, entry.message.id);
      }
    }
    return new Set(terminalIdsByTurn.values());
  })();
  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = props.latestRun;
    if (!props.latestRun || !previous) {
      return;
    }
    if (props.latestRun.runId === previous.runId) {
      if (previous.status === "running" && props.latestRun.status === "interrupted") {
        const interruptedTurnId = props.latestRun.runId;
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(interruptedTurnId),
        }));
      }
      return;
    }
    setInteractionState((current) => {
      if (!current.expandedTurnIds.has(previous.runId)) {
        return current;
      }
      const next = new Set(current.expandedTurnIds);
      next.delete(previous.runId);
      return { ...current, expandedTurnIds: next };
    });
  }, [props.latestRun]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
      if (disclosureSettleFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
      if (disclosureSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
      }
    };
  }, []);

  const settleDisclosureAfterLayout = () => {
    if (disclosureSettleFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    if (disclosureSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
    }
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        const listState = listRef.current?.getState();
        if (listState) {
          transitionEndFollow({
            type: "disclosure-settled",
            isAtEnd: listState.isAtEnd,
            userScrollSessionActive: userScrollSessionRef.current,
          });
        }
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        disclosureSettleFrameRef.current = null;
        disclosureSettleSecondFrameRef.current = null;
      });
    });
  };

  const suspendEndScrollMaintenanceForDisclosure = (anchorKey: string | null) => {
    cancelReflow();
    disclosureAnchorKeyRef.current = anchorKey;
    setDisclosureToggleSettling(true);
  };

  // Start settling after React commits and restart on each size change, so end maintenance waits for LegendList correction.
  useLayoutEffect(() => {
    if (disclosureAnchorKeyRef.current !== null) {
      settleDisclosureAfterLayout();
    }
  }, [expandedTurnIds, expandedWorkGroups, expandedWorkRows, settleDisclosureAfterLayout]);

  const handleItemSizeChanged = () => {
    if (disclosureAnchorKeyRef.current !== null) {
      settleDisclosureAfterLayout();
    }
  };

  const shouldRestoreVisibleContentPosition = (entry: ThreadFeedRow) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || entry.id === disclosureAnchorKey;
  };

  const maintainVisibleContentPosition = {
    data: true,
    size: true,
    shouldRestorePosition: shouldRestoreVisibleContentPosition,
  };

  const onCopyWorkRow = (rowId: string, value: string) => {
    copyTextWithHaptic(value, {
      target: "thread-work-row",
      feedback: "selection",
    });
    setInteractionState((current) => ({ ...current, copiedRowId: rowId }));
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setInteractionState((current) =>
        current.copiedRowId === rowId ? { ...current, copiedRowId: null } : current,
      );
      copyFeedbackTimeoutRef.current = null;
    }, 1200);
  };

  const onToggleWorkGroup = (groupId: string, anchorKey?: string) => {
    suspendEndScrollMaintenanceForDisclosure(anchorKey ?? `work-toggle:${groupId}`);
    setInteractionState((current) => ({
      ...current,
      expandedWorkGroups: {
        ...current.expandedWorkGroups,
        [groupId]: !(current.expandedWorkGroups[groupId] ?? false),
      },
    }));
  };

  // Lone rows share their group's disclosure state so opened details survive a second call joining.
  const onToggleWorkRow = (rowId: string, anchorKey?: string, groupId?: string) => {
    suspendEndScrollMaintenanceForDisclosure(anchorKey ?? null);
    setInteractionState((current) => {
      const expanded = !(current.expandedWorkRows[rowId] ?? false);
      return {
        ...current,
        expandedWorkRows: { ...current.expandedWorkRows, [rowId]: expanded },
        ...(groupId === undefined
          ? {}
          : { expandedWorkGroups: { ...current.expandedWorkGroups, [groupId]: expanded } }),
      };
    });
  };

  const onToggleTurnFold = (runId: RunId) => {
    suspendEndScrollMaintenanceForDisclosure(`run-fold:${runId}`);
    setInteractionState((current) => {
      const next = new Set(current.expandedTurnIds);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return { ...current, expandedTurnIds: next };
    });
  };

  const onPressPreview = (source: FilePreviewSource) => {
    markdownLinkRequest.current?.abort();
    setExpandedFile((current) => current ?? source);
  };
  const onPressVideo = (attachment: ChatFileAttachment, sourceIdentifier: string) => {
    markdownLinkRequest.current?.abort();
    setExpandedVideo(
      (current) =>
        current ?? attachmentVideoPreviewSource(props.environmentId, attachment, sourceIdentifier),
    );
  };

  // Without this, every row above the viewport is assumed to be
  // estimatedItemSize tall, and scrolling up through unmeasured content
  // corrects each row's height as it mounts — the feed visibly jumps.
  const getFixedItemSize = (entry: ThreadFeedRow) => {
    if (entry.type === "guest-pending") return undefined;
    if (entry.type === "html-render") {
      return htmlRenderRowHeight(htmlRenderFrameHeight(entry.render, contentWidth));
    }
    if (workRowSizing.fixedRowHeight === undefined || entry.checkpointSummary) {
      return undefined;
    }
    switch (entry.type) {
      case "run-fold":
        return resolveThreadFeedFixedItemSize(entry.type);
      case "work-toggle":
        return entry.thought ? undefined : WORK_GROUP_TOGGLE_HEIGHT;
      case "thinking":
        return WORK_GROUP_TOGGLE_HEIGHT;
      case "activity-group":
        if (entry.activities[0]?.projectedItem.item.type === "subagent") {
          return undefined;
        }
        if (isContextCompactionActivityGroup(entry) || isContextHandoffActivityGroup(entry)) {
          return undefined;
        }
        if (
          entry.activities[0]?.groupedToolDetail &&
          entry.activities.every((activity) => activity.workEntry.itemType === "reasoning")
        ) {
          return undefined;
        }
        return entry.activities.some(
          (activity) => activity.prominent || expandedWorkRows[activity.id],
        )
          ? undefined
          : collapsedWorkLogHeight(entry.activities, entry.continuesWorkLog);
      default:
        return undefined;
    }
  };
  const hasHtmlRenders = presentedFeed.some((entry) => entry.type === "html-render");
  const previousContentWidth = useRef(contentWidth);
  useLayoutEffect(() => {
    if (previousContentWidth.current === contentWidth) return;
    previousContentWidth.current = contentWidth;
    // Rows re-rendered at this width are measured in the next commit, after this effect.
    beginReflow();
    if (hasHtmlRenders) listRef.current?.clearCaches({ mode: "sizes" });
  }, [beginReflow, contentWidth, hasHtmlRenders, listRef]);

  const renderItem = (info: { item: ThreadFeedRow; index: number }) => (
    <Animated.View
      key={info.item.id}
      entering={disclosureToggleSettling ? THREAD_FEED_DISCLOSURE_ENTER_TRANSITION : undefined}
    >
      <MessageImageGalleryScope
        entry={info.item}
        environmentId={props.environmentId}
        threadId={props.threadId}
        workspaceRoot={props.workspaceRoot}
      >
        <ThreadMediaVisibility>
          {renderFeedEntry(info, {
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
            onPressPreview,
            onPressVideo,
            markdownLinkHandlers,
            renderMarkdownImage,
            renderViewedImage,
            renderReasoning,
            iconSubtleColor,
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
    </Animated.View>
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
          <KeyboardAwareLegendList
            ref={listRef}
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
              disclosureToggleSettling || !endFollowEnabled
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
              endFollowEnabled && !disclosureToggleSettling ? false : maintainVisibleContentPosition
            }
            data={presentedFeed}
            extraData={listAppearanceData}
            renderItem={renderItem}
            viewabilityConfig={THREAD_MEDIA_VIEWABILITY_CONFIG}
            keyExtractor={(entry) => entry.id}
            getItemType={(entry) => {
              if (entry.type !== "message") return entry.type;
              if (isCompactionCommandFeedEntry(entry)) return "message:compaction";
              const { attribution } = resolveUserMessagePresentation(entry.message);
              return attribution === "automation" || attribution === "agent"
                ? `message:${attribution}`
                : `message:${entry.message.role}`;
            }}
            getFixedItemSize={getFixedItemSize}
            // Native layout transitions retain stale row positions during sync, even at duration zero.
            onItemSizeChanged={handleItemSizeChanged}
            drawDistance={500}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            keyboardLiftBehavior="whenAtEnd"
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
              paddingTop: FEED_PADDING_TOP,
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
        <VideoPreviewModal source={expandedVideo} onRequestClose={() => setExpandedVideo(null)} />
        <FilePreviewModal source={expandedFile} onRequestClose={() => setExpandedFile(null)} />
      </View>
    </PresentationSource>
  );
});

function ThreadFeedLoadEarlierControl(props: ThreadFeedHistoryControls) {
  const theme = useUniwindTheme();
  const mutedColor = theme["--color-icon-subtle"];
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <View className="mb-3 items-center gap-1.5 px-2">
      {props.hasMoreHistory ? (
        <View className="self-center">
          <Button
            label={props.loading ? "Loading earlier activity…" : "Load earlier activity"}
            tone="secondary"
            accessibilityLabel="Load earlier activity"
            disabled={props.loading}
            onPress={props.onLoadEarlier}
            icon="chevron.up"
            loading={props.loading}
          />
        </View>
      ) : null}
      {props.error !== null ? (
        <Text className="text-center text-xs" style={{ color: mutedColor }}>
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}

function MessageImageGalleryScope(props: {
  entry: ThreadFeedRow;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  workspaceRoot: string | null | undefined;
  children: ReactNode;
}) {
  const { entry, environmentId, threadId, workspaceRoot } = props;
  const images =
    entry.type === "message"
      ? [
          ...messageImageGallery(entry.message, { environmentId, threadId, workspaceRoot }),
          ...composerImageGallery(entry.pendingMessage?.attachments ?? []),
        ]
      : [];
  return <FilePreviewGallery value={images}>{props.children}</FilePreviewGallery>;
}
