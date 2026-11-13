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

export function MessageAttachmentFile(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatFileAttachment;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onPlaybackStart: () => void;
  readonly standaloneMedia?: boolean;
  readonly standaloneFile?: boolean;
  readonly available?: boolean;
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
      // oxlint-disable-next-line react/memo-dependencies -- Changing the attachment or connection cancels the previous file open even while this screen stays focused.
    }, [props.environmentId, attachment.id, httpBaseUrl]),
  );

  const shareFile = (sourceIdentifier?: string) => {
    if (props.available === false || httpBaseUrl === null || openingRef.current) return;
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

  const openAttachment = () =>
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
        });
  const inlineKind = inlineFilePreviewKind(attachment);
  if (inlineKind) {
    return (
      <PresentationSource identifier={sourceIdentifier}>
        <ThreadInlineFilePreview
          key={attachment.id}
          source={{
            kind: "document",
            name: attachment.name,
            mimeType: attachment.mimeType,
            environmentId: props.environmentId,
            resource: {
              _tag: "attachment",
              attachmentId: attachment.id,
              fileName: attachment.name,
              mimeType: attachment.mimeType,
              disposition: "inline",
            },
          }}
          sizeBytes={attachment.sizeBytes}
          onOpen={openAttachment}
          onPlaybackStart={props.onPlaybackStart}
          onLongPress={() => shareFile(sourceIdentifier)}
        />
      </PresentationSource>
    );
  }

  if (videoType !== null) {
    return (
      <View
        className={props.standaloneMedia ? undefined : "my-1"}
        style={{ width: props.standaloneMedia ? 320 : 224, maxWidth: "100%" }}
      >
        <ThreadMarkdownVideo
          source={attachmentVideoPreviewSource(props.environmentId, attachment, sourceIdentifier)}
          onPlaybackStart={props.onPlaybackStart}
          borderRadius={props.standaloneMedia ? 20 : undefined}
        />
      </View>
    );
  }

  const disabled = props.available === false || opening || httpBaseUrl === null;
  return (
    <PresentationSource
      identifier={sourceIdentifier}
      className="my-1"
      style={{ width: 280, maxWidth: "100%" }}
    >
      <View className="min-w-0 flex-row items-center overflow-hidden rounded-xl border border-border bg-card">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${attachment.name}`}
          accessibilityValue={{ text: `${fileTypeLabel}, ${sizeLabel}` }}
          accessibilityState={{ disabled, busy: opening }}
          disabled={disabled}
          className="min-w-0 flex-1 flex-row items-center gap-3 p-3 active:bg-subtle"
          onLongPress={() => shareFile(sourceIdentifier)}
          onPress={openAttachment}
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
        {props.standaloneFile ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Download ${attachment.name}`}
            accessibilityState={{ disabled, busy: opening }}
            disabled={disabled}
            className="mr-1 min-h-11 w-11 items-center justify-center rounded-lg active:bg-subtle disabled:opacity-40"
            onPress={() => shareFile(sourceIdentifier)}
          >
            <SymbolView name="arrow.down" size={16} tintColorClassName="accent-foreground-muted" />
          </Pressable>
        ) : null}
      </View>
    </PresentationSource>
  );
}

