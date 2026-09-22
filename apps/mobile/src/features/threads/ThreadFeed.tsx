import {
  WorktreeWorkingHeader,
  WorktreeSetupCard,
  type WorktreeSetupCardProps,
} from "./worktree-setup-card";
import * as Haptics from "expo-haptics";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { useViewabilityAmount, type LegendListRef } from "@legendapp/list/react-native";
import type {
  ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  EnvironmentId,
  MessageId,
  OrchestrationMessageContext,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";
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
} from "@t3tools/client-runtime/codex-artifact-templates";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import {
  renderCodexFileCitationsAsMarkdown,
  splitCodexArtifactTemplateMarkdown,
} from "@t3tools/client-runtime/codex-markdown-directives";
import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { isPdfFile } from "../../lib/filePreview";
import { flattenThemeColor } from "../../lib/mobileTheme";
import { PresentationSource } from "../../components/NativePresentation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, type SharedValue } from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { useFontFamily } from "../../lib/useFontFamily";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { hasWideMarkdownBlock } from "../../lib/wideMarkdownBlocks";
import {
  SelectableMarkdownText,
  type MarkdownFileContextMenu,
  type MarkdownImageRenderer,
  type MarkdownLinkCustomization,
  type MarkdownImageSourceResolver,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";

import { AppText as Text } from "../../components/AppText";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { VideoAttachmentTile } from "../../components/VideoAttachmentTile";
import { ThreadMarkdownVideo, ThreadMediaVisibleContext } from "./ThreadMarkdownVideo";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { attachmentVideoPreviewSource } from "../../lib/videoPreviewSource";
import { CopyTextButton } from "../../components/CopyTextButton";
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
import { resolveNativeMarkdownTypography } from "../../lib/appearancePreferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { markdownFileIconSource } from "../../lib/markdownFileIcons";
import { enrichedContextLinkPresentation } from "../../lib/enrichedLinkPresentation";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import {
  normalizeNativeMarkdownUrl,
  resolveMarkdownLinkPresentation,
} from "../../lib/markdownLinks";
import {
  deriveThreadFeedPresentation,
  deriveUnsettledTurnId,
  isContextCompactionActivityGroup,
  type ThreadFeedEntry,
  type ThreadFeedLatestTurn,
} from "../../lib/threadActivity";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import {
  resolveThreadFeedLiveFollow,
  type ThreadFeedLiveFollowEvent,
  type ThreadWorkGroupScrollPosition,
} from "./thread-feed-live-follow";
import {
  collapsedWorkLogHeight,
  ThreadAgentSpawnCard,
  ThreadDisclosureChevron,
  ThreadReasoningRow,
  ThreadWorkGroupToggle,
  ThreadThinkingRow,
  ThreadWorkLog,
  THREAD_DISCLOSURE_TRANSITION_MS,
  WORK_GROUP_TOGGLE_HEIGHT,
} from "./thread-work-log";
import { appendPendingThreadMessages, type PendingThreadFeedEntry } from "./pending-thread-feed";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { assetEnvironment, useAssetUrl, useRefreshAssetUrl } from "../../state/assets";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { usePreparedConnection } from "../../state/session";
import { useThreadSelection } from "../../state/use-thread-selection";
import { composerDocumentAttachmentRecord } from "../../lib/composerContext";
import * as Option from "effect/Option";
import {
  basename,
  fileRoutePathSegments,
  isAbsolutePath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";
import { fileChipMenu, resolveFileChipTarget, type FileChipAction } from "./fileChipMenu";
import { useFileChipShare } from "./useFileChipShare";
import {
  MarkdownImageAvailableWidthContext,
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";

/** `ml-7` gutter plus the `px-3` padding of the expanded reasoning container. */
const REASONING_CONTENT_INSET = 52;

const WIDE_MARKDOWN_BLOCK_OPTIONS = {
  // Native iOS blockquotes and adjacent selectable text are separate layout
  // chunks. Giving their shrink-to-fit bubble a definite width keeps both
  // chunks measured against the width at which UIKit draws them.
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

// Fixed heights mirror renderFeedEntry's classNames and are only used while
// text fits at the current font settings. Larger accessibility text is measured.
const TURN_FOLD_HEIGHT = 42; // min-h-11 (38.5) + mb-1 (3.5), with the mobile 14px rem
// Tailwind spacing on the mobile 14px rem: px-3.5 on the user bubble, px-1 on
// assistant rows. Images size their frame from these before their own layout.
const USER_BUBBLE_HORIZONTAL_PADDING = 3.5 * 3.5;
const ASSISTANT_ROW_HORIZONTAL_PADDING = 3.5;
// Let neighboring rows move out of the new rows' space before showing their text.
const THREAD_FEED_DISCLOSURE_ENTER_TRANSITION = FadeIn.delay(
  THREAD_DISCLOSURE_TRANSITION_MS,
).duration(140);

// Entering animations must only play for rows born just now — LegendList
// remounts rows when they scroll back into view, and replaying an entrance for
// old content would be its own kind of jank.
const FRESH_ENTRY_WINDOW_MS = 3_000;
function isFreshTimestamp(input: string): boolean {
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ENTRY_WINDOW_MS;
}

export interface ThreadFeedProps {
  readonly worktreeSetup?: WorktreeSetupCardProps | null;
  readonly setupWorkingStartedAt?: string | null;
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly dispatchingMessageId: MessageId | null;
  readonly onEditPendingMessage: (message: QueuedThreadMessage) => void;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot?: string | null;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly contentPresentation: ThreadContentPresentation;
  readonly agentLabel: string;
  readonly latestTurn: ThreadFeedLatestTurn | null;
  readonly activeWorkStartedAt: string | null;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly freeze: SharedValue<boolean>;
  readonly anchorMessageId: MessageId | null;
  readonly submittedMessageId: MessageId | null;
  readonly contentInsetEndAdjustment: SharedValue<number>;
  readonly contentTopInset?: number;
  readonly contentBottomInset?: number;
  readonly contentMaxWidth?: number;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onEndFollowEnabledChange?: (enabled: boolean) => void;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
  /** Non-null when older turns exist beyond the loaded window. */
  readonly loadEarlier?: {
    readonly loading: boolean;
    readonly onLoadEarlier: () => void;
  } | null;
}

function MessageAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly className: string;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
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

  if (uri === null) {
    return (
      <View className={`${props.className} items-center justify-center`}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <PresentationSource identifier={sourceIdentifier}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open ${props.name}`}
        onPress={() =>
          // The viewer mints its own URL from the resource so the image survives a refresh.
          props.onPressPreview({
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
          })
        }
      >
        <Image
          source={{ uri }}
          className={props.className}
          resizeMode="cover"
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

// The attachment union has an open member (`type: string` for attachment
// types from newer servers), so literal comparisons do not narrow it. Split
// with guards and render unknown types as inert rows, never crash.
function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {
  // Messages sent before pictures were typed by content carry `file`; they are still
  // pictures, and reading them as such is what lets them keep their thumbnail.
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
    void (async () => {
      try {
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
        if (controller.signal.aborted) return;
        if (result._tag === "Failure") {
          throw squashAtomCommandFailure(result);
        }
        const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
        if (url === null) {
          throw new Error("The attachment could not be opened.");
        }
        await downloadAndShareAttachment({
          url,
          attachment,
          signal: controller.signal,
          sourceIdentifier,
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          Alert.alert(
            "Could not open attachment",
            error instanceof Error ? error.message : "The attachment is unavailable.",
          );
        }
      } finally {
        if (openingRef.current === controller) {
          openingRef.current = null;
          setOpening(false);
        }
      }
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
              <ActivityIndicator size="small" />
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

/**
 * An attachment type this build does not know (newer server). Rendered as an
 * inert row: the name is still useful, but there is nothing to open.
 */
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

function ThreadMediaVisibility(props: { readonly children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useViewabilityAmount<ThreadFeedEntry>(
    useCallback((token) => setVisible(token.sizeVisible > 0), []),
  );
  return <ThreadMediaVisibleContext value={visible}>{props.children}</ThreadMediaVisibleContext>;
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Use ${props.template.displayName} template`}
          className="min-h-9 justify-center rounded-lg border border-border bg-subtle px-3 active:opacity-65"
          onPress={() => props.onUse?.(props.template)}
        >
          <Text className="font-t3-bold text-xs text-foreground">Use template</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Tap opens a link; long-press on a native file chip shows its menu. Built once per feed. */
interface MarkdownLinkHandlers {
  readonly resolveImageSource?: MarkdownImageSourceResolver;
  readonly onImagePress?: (href: string) => void;
  readonly onLinkPress: (href: string) => void;
  readonly fileContextMenu: (href: string) => MarkdownFileContextMenu | undefined;
  readonly onFileContextMenuAction: (href: string, actionId: string) => void;
  readonly linkCustomization?: (href: string) => MarkdownLinkCustomization | undefined;
}

const AssistantMarkdownContent = memo(function AssistantMarkdownContent(props: {
  readonly markdown: string;
  readonly markdownStyles: MarkdownStyleSet;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  readonly renderImage: MarkdownImageRenderer;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined;
}) {
  const segments = useMemo(
    () => splitCodexArtifactTemplateMarkdown(props.markdown),
    [props.markdown],
  );

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

    const markdown = renderCodexFileCitationsAsMarkdown(segment.markdown);
    return (
      <SelectableMarkdownText
        key={`markdown:${segment.sourceOffset}`}
        markdown={markdown}
        skills={props.skills}
        textStyle={props.markdownStyles.nativeTextStyle}
        {...props.linkHandlers}
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
  const inlineSkillForeground = theme["--color-inline-skill-foreground"];
  const userBubbleSkillForeground = theme["--color-user-bubble-skill-foreground"];
  const regularFontFamily = useFontFamily("regular");
  const boldFontFamily = useFontFamily("bold");

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
          skillTextColor: userBubbleSkillForeground,
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
          skillTextColor: inlineSkillForeground,
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
    inlineSkillForeground,
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
    userBubbleSkillForeground,
  ]);
}

function renderFeedEntry(
  info: { item: PendingThreadFeedEntry; index: number },
  props: Pick<
    ThreadFeedProps,
    | "environmentId"
    | "onUseArtifactTemplate"
    | "skills"
    | "dispatchingMessageId"
    | "onEditPendingMessage"
  > & {
    readonly copiedRowId: string | null;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly expandedReasoningMessageIds: ReadonlySet<string>;
    readonly workRowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
    readonly workGroupScrollPositions: Map<string, ThreadWorkGroupScrollPosition>;
    readonly terminalAssistantMessageIds: ReadonlySet<string>;
    readonly unsettledTurnId: TurnId | null;
    readonly isWorking: boolean;
    readonly onCopyWorkRow: (rowId: string, value: string) => void;
    readonly onToggleWorkGroup: (groupId: string, anchorKey: string) => void;
    readonly onToggleWorkRow: (rowId: string, anchorKey: string) => void;
    readonly onToggleTurnFold: (turnId: TurnId) => void;
    readonly onToggleReasoning: (messageId: string) => void;
    readonly onPressPreview: (source: FilePreviewSource) => void;
    readonly onPressVideo: (attachment: ChatFileAttachment, sourceIdentifier: string) => void;
    readonly markdownLinkHandlers: MarkdownLinkHandlers;
    readonly renderMarkdownImage: MarkdownImageRenderer;
    readonly renderViewedImage: MarkdownImageRenderer;
    readonly iconSubtleColor: string | import("react-native").ColorValue;
    readonly screenColor: string;
    readonly userBubbleColor: string | import("react-native").ColorValue;
    readonly markdownStyles: MarkdownStyleSets;
    readonly reviewCommentColors: ReviewCommentColors;
    readonly reviewCommentBubbleWidth: number;
    readonly themeAppearance: "light" | "dark";
    readonly userBubbleMaxWidth: number;
    /** Width assistant markdown lays out in, so images can size their frame before layout. */
    readonly markdownContentWidth: number;
  },
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props;

  if (entry.type === "turn-fold") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: entry.expanded }}
        onPress={() => props.onToggleTurnFold(entry.turnId)}
        hitSlop={4}
        className="mb-1 min-h-11 flex-row items-center gap-2 border-b border-border-subtle px-2"
        style={{
          minHeight: Math.max(TURN_FOLD_HEIGHT - 3.5, props.workRowSizing.estimatedRowHeight),
        }}
      >
        <Text
          key={props.workRowSizing.textSizeKey}
          className="font-t3-medium text-sm tabular-nums text-foreground-muted"
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
    );
  }

  if (entry.type === "thinking") {
    return <ThreadThinkingRow rowSizing={props.workRowSizing} iconSubtleColor={iconSubtleColor} />;
  }

  if (entry.type === "agent-spawn") {
    return (
      <ThreadAgentSpawnCard
        summary={entry.summary}
        expanded={entry.expanded}
        iconSubtleColor={iconSubtleColor}
        rowSizing={props.workRowSizing}
        onToggle={() => props.onToggleWorkGroup(entry.id, entry.id)}
        onCopy={() => props.onCopyWorkRow(entry.activity.id, entry.activity.getCopyText())}
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
        onToggle={() => props.onToggleWorkGroup(entry.groupId, entry.id)}
      />
    );
  }

  if (entry.type === "activity-group" && isContextCompactionActivityGroup(entry)) {
    const label = entry.activities[0]!.summary;
    return (
      <View
        accessible
        accessibilityLabel={label}
        className="mb-3 flex-row items-center gap-3 px-1 py-1"
      >
        <View className="h-px flex-1 bg-subtle" />
        <View className="shrink-0 flex-row items-center gap-1.5">
          <SymbolView
            name="arrow.down.right.and.arrow.up.left"
            size={12}
            tintColor={iconSubtleColor}
            type="monochrome"
          />
          <Text className="font-t3-medium text-xs text-foreground-muted">{label}</Text>
        </View>
        <View className="h-px flex-1 bg-subtle" />
      </View>
    );
  }

  if (entry.type === "message") {
    const { message } = entry;
    if (message.role === "reasoning") {
      const messages = entry.reasoningMessages ?? [message];
      return (
        <ThreadReasoningRow
          rowSizing={props.workRowSizing}
          iconSubtleColor={iconSubtleColor}
          expanded={props.expandedReasoningMessageIds.has(entry.id)}
          label={`Thought${messages.length > 1 ? ` (×${messages.length})` : ""}`}
          streaming={false}
          onToggle={() => props.onToggleReasoning(entry.id)}
        >
          <MarkdownImageAvailableWidthContext
            value={props.markdownContentWidth - REASONING_CONTENT_INSET}
          >
            <View className="gap-3">
              {messages.map((reasoningMessage) => (
                <AssistantMarkdownContent
                  key={reasoningMessage.id}
                  markdown={reasoningMessage.text}
                  markdownStyles={markdownStyles.assistant}
                  linkHandlers={props.markdownLinkHandlers}
                  renderImage={props.renderMarkdownImage}
                  skills={props.skills}
                />
              ))}
            </View>
          </MarkdownImageAvailableWidthContext>
        </ThreadReasoningRow>
      );
    }
    const isUser = message.role === "user";
    const renderedText = renderAssistantCitationsAsText(message.text);
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;
    const timestampLabel = formatMessageTime(isUser ? message.createdAt : message.updatedAt);
    const attachments = message.attachments ?? [];
    const hasReviewCommentContext = message.text.includes("<review_comment");
    // A bubble that sizes itself from its content cannot lay out a block whose
    // intrinsic width overflows `maxWidth`: Android positions the bubble's
    // children during the unclamped pass and never moves them once the width
    // is clamped, so the paragraphs around the block end up drawn on top of
    // each other. Pinning the width removes that pass.
    const hasWideBlock = hasWideMarkdownBlock(renderedText, WIDE_MARKDOWN_BLOCK_OPTIONS);
    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      props.unsettledTurnId !== null &&
      message.turnId === props.unsettledTurnId;
    const showAssistantMeta =
      message.role === "assistant" &&
      props.terminalAssistantMessageIds.has(message.id) &&
      !assistantTurnStillInProgress &&
      !message.streaming;

    if (isUser) {
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
        <View className="mb-5 items-end">
          <View
            className="min-w-0 gap-2 rounded-[20px] px-3.5 py-2.5"
            style={{
              backgroundColor: userBubbleColor,
              maxWidth: props.userBubbleMaxWidth,
              ...(hasReviewCommentContext
                ? { width: props.reviewCommentBubbleWidth }
                : hasWideBlock
                  ? { width: props.userBubbleMaxWidth }
                  : null),
            }}
          >
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
                <Image
                  key={attachment.id}
                  source={{ uri: attachment.previewUri }}
                  accessibilityLabel={attachment.name}
                  style={{ width: 180, height: 140, borderRadius: 14 }}
                />
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
          <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
            <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
              {entry.pendingMessage && !entry.acknowledged ? "Pending" : timestampLabel}
            </Text>
            {entry.pendingMessage &&
            !entry.acknowledged &&
            !entry.pendingMessage.creation &&
            entry.pendingMessage.messageId !== props.dispatchingMessageId ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit pending message"
                hitSlop={8}
                className="size-7 items-center justify-center"
                onPress={() => {
                  if (entry.pendingMessage) props.onEditPendingMessage(entry.pendingMessage);
                }}
              >
                <SymbolView name="pencil" size={14} tintColor={iconSubtleColor} />
              </Pressable>
            ) : null}
            {message.text.trim().length > 0 ? (
              <CopyTextButton
                accessibilityLabel="Copy message"
                text={message.text}
                onCopy={
                  message.context
                    ? () =>
                        writeComposerContextClipboard(message.text, {
                          version: 1,
                          source: { environmentId: props.environmentId, messageId: message.id },
                          records: message.context!.records,
                        })
                    : undefined
                }
                tintColor={iconSubtleColor}
                buttonSize={28}
                iconSize={13}
              />
            ) : null}
          </View>
        </View>
      );
    }

    // Skip empty assistant messages (no text, no attachments) — they would
    // render as an orphaned timestamp and break adjacent activity-group merging.
    if (renderedText.trim().length === 0 && attachments.length === 0) {
      return null;
    }

    // Assistant messages hit the same Android unclamped-pass bug as user
    // bubbles: wide markdown blocks cause children to be positioned at
    // intrinsic width before the container is clamped, overlapping the
    // timestamp/copy button row. Pinning the width removes that pass.
    const enterAnimated = isFreshTimestamp(message.createdAt);
    return (
      <Animated.View
        className={cn(showAssistantMeta ? "mb-5 px-1" : "mb-1 px-1", hasWideBlock && "w-full")}
        {...(enterAnimated ? { entering: FadeIn.duration(220) } : {})}
      >
        {renderedText.trim().length > 0 ? (
          <MarkdownImageAvailableWidthContext value={props.markdownContentWidth}>
            <AssistantMarkdownContent
              markdown={renderedText}
              markdownStyles={styles}
              linkHandlers={props.markdownLinkHandlers}
              onUseArtifactTemplate={props.onUseArtifactTemplate}
              renderImage={props.renderMarkdownImage}
              skills={props.skills}
            />
          </MarkdownImageAvailableWidthContext>
        ) : null}
        {attachments.map((attachment) => {
          return isImageAttachment(attachment) ? (
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
          );
        })}
        {showAssistantMeta ? (
          <View className="mt-1 flex-row items-center gap-1">
            <CopyTextButton
              accessibilityLabel="Copy message"
              text={renderedText}
              tintColor={iconSubtleColor}
              buttonSize={28}
              iconSize={13}
            />
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
      // Fixed native rows need fresh measurement after a text-size change.
      // Anchors/details live in ThreadFeed and survive this group-only remount.
      key={`${entry.id}:${props.workRowSizing.textSizeKey}`}
      activities={entry.activities}
      environmentId={props.environmentId}
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
    />
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
  const { selectedThread } = useThreadSelection();
  const text = replaceComposerContextReferences(props.text, (ref) => {
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
    // Documents open in the file screen; pictures, video and PDF keep their native viewers.
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
                  Alert.alert("Could not copy context", "Try copying this context again.");
                });
            }
          },
          linkCustomization: (href) => {
            const presentation = enrichedContextLinkPresentation(href, props.context?.records);
            return presentation
              ? { color: presentation.color, icon: markdownFileIconSource(presentation.icon) }
              : props.linkHandlers.linkCustomization?.(href);
          },
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
  if (!hasReviewComment) {
    return (
      <SelectableMarkdownText
        markdown={text}
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

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const navigation = useNavigation();
  const { themeAppearance } = useAppearancePreferences();
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const headerMaterialVisibleRef = useRef(false);
  const previousLatestTurnRef = useRef(props.latestTurn);
  const userScrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const { appearance } = useAppearancePreferences();
  const workRowSizing = useMemo(
    () => deriveThreadWorkLogSizing({ baseFontSize: appearance.baseFontSize, fontScale }),
    [appearance.baseFontSize, fontScale],
  );
  const previousTextSize = useRef(workRowSizing.textSizeKey);
  useLayoutEffect(() => {
    if (previousTextSize.current === workRowSizing.textSizeKey) {
      return;
    }
    previousTextSize.current = workRowSizing.textSizeKey;
    // Text-size changes invalidate the outer list's fixed-height cache too.
    // This never runs for scrolling, streamed output, or disclosure toggles.
    props.listRef.current?.clearCaches({ mode: "sizes" });
  }, [workRowSizing.textSizeKey, props.listRef]);
  const [viewportWidth, setViewportWidth] = useState(() =>
    props.layoutVariant === "split" ? 0 : windowWidth,
  );
  const [viewportHeight, setViewportHeight] = useState(0);
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  // Live-follow latch. LegendList's maintainScrollAtEnd alone re-pins the feed
  // whenever the viewport drifts back inside its geometric threshold, which
  // yanked users off history they were reading every time a stream chunk grew
  // a row. Scrolling away or expanding a disclosure above the end breaks
  // follow; reaching the end (or sending / switching threads) re-arms it.
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  const endFollowEnabledRef = useRef(true);
  // A "user scroll session" spans from drag start through the end of its
  // momentum; scroll events only break follow inside that session, so MVCP
  // compensations and programmatic scrolls never strand a follower.
  const userScrollSessionRef = useRef(false);
  const setEndFollow = useCallback(
    (enabled: boolean) => {
      if (endFollowEnabledRef.current === enabled) {
        return;
      }
      endFollowEnabledRef.current = enabled;
      setEndFollowEnabled(enabled);
      props.onEndFollowEnabledChange?.(enabled);
    },
    [props.onEndFollowEnabledChange],
  );
  const transitionEndFollow = useCallback(
    (event: ThreadFeedLiveFollowEvent) => {
      setEndFollow(resolveThreadFeedLiveFollow(endFollowEnabledRef.current, event));
    },
    [setEndFollow],
  );
  const [interactionState, setInteractionState] = useState<{
    readonly copiedRowId: string | null;
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly expandedTurnIds: ReadonlySet<TurnId>;
    readonly expandedReasoningMessageIds: ReadonlySet<string>;
  }>({
    copiedRowId: null,
    expandedWorkGroups: {},
    expandedWorkRows: {},
    expandedTurnIds: new Set(),
    expandedReasoningMessageIds: new Set(),
  });
  const {
    copiedRowId,
    expandedWorkGroups,
    expandedWorkRows,
    expandedTurnIds,
    expandedReasoningMessageIds,
  } = interactionState;
  const [expandedFile, setExpandedFile] = useState<FilePreviewSource | null>(null);
  const [expandedVideo, setExpandedVideo] = useState<VideoPreviewSource | null>(null);
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
  const contentHorizontalPadding = deriveCenteredContentHorizontalPadding({
    viewportWidth,
    maxContentWidth: props.contentMaxWidth ?? null,
    minimumPadding: horizontalPadding,
  });
  const contentWidth = Math.max(0, viewportWidth - contentHorizontalPadding * 2);
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
  // With automatic insets the header inset lives in UIKit's adjustedContentInset,
  // which LegendList's JS anchoring math cannot see — it measures the anchored
  // end space from the scroll view's frame top. Fold the header height back into
  // the anchor offset or a just-sent message anchors underneath the header and
  // the oversized end space keeps maintainScrollAtEnd snapping away from earlier
  // messages. Read the context directly (useHeaderHeight throws outside a
  // header-providing screen) and fall back to the standard iOS bar height.
  const navigationHeaderHeight = useContext(HeaderHeightContext);
  const anchorTopInset = usesNativeAutomaticInsets
    ? navigationHeaderHeight || insets.top + IOS_NAV_BAR_HEIGHT
    : topContentInset;

  const theme = useUniwindTheme();
  const iconSubtleColor = theme["--color-icon-subtle"];
  const screenColor = theme["--color-screen"];
  const userBubbleColor = theme["--color-user-bubble"];
  const onMarkdownLinkPress = useCallback(
    (href: string) => {
      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        const relativePath = resolveWorkspaceRelativeFilePath(
          props.workspaceRoot,
          presentation.path,
        );
        if (relativePath) {
          void Haptics.selectionAsync();
          if (isPdfFile({ name: relativePath })) {
            setExpandedFile(
              (current) =>
                current ?? {
                  kind: "pdf",
                  name: relativePath.split("/").at(-1),
                  environmentId: props.environmentId,
                  resource: {
                    _tag: "workspace-file",
                    threadId: props.threadId,
                    path: relativePath,
                  },
                },
            );
            return;
          }
          navigation.navigate("ThreadFile", {
            environmentId: String(props.environmentId),
            threadId: String(props.threadId),
            path: fileRoutePathSegments(relativePath),
            ...(presentation.line ? { line: String(presentation.line) } : {}),
          });
          return;
        }
      }

      const media = resolveMarkdownMediaPreview(href, {
        environmentId: props.environmentId,
        threadId: props.threadId,
        workspaceRoot: props.workspaceRoot,
      });
      if (media) {
        void Haptics.selectionAsync();
        if (media.kind === "video") {
          setExpandedVideo((current) => current ?? media.source);
        } else {
          setExpandedFile((current) => current ?? media.source);
        }
        return;
      }

      // A host file outside the workspace, such as a report an agent wrote to
      // a temp directory, opens read-only in the file screen.
      if (presentation.kind === "file" && isAbsolutePath(presentation.path)) {
        void Haptics.selectionAsync();
        if (isPdfFile({ name: presentation.path })) {
          setExpandedFile(
            (current) =>
              current ?? {
                kind: "pdf",
                name: basename(presentation.path),
                environmentId: props.environmentId,
                resource: {
                  _tag: "media-file",
                  threadId: props.threadId,
                  path: presentation.path,
                },
              },
          );
          return;
        }
        navigation.navigate("ThreadFile", {
          environmentId: String(props.environmentId),
          threadId: String(props.threadId),
          path: fileRoutePathSegments(presentation.path),
          ...(presentation.line ? { line: String(presentation.line) } : {}),
        });
        return;
      }

      if (presentation.kind !== "file" && presentation.href) {
        if (/^https?:\/\//i.test(presentation.href) && isPdfFile({ name: presentation.href })) {
          setExpandedFile(
            (current) => current ?? { kind: "pdf", uri: presentation.href!, name: "Document.pdf" },
          );
          return;
        }
        void tryOpenExternalUrl(presentation.href, "markdown-link");
      }
    },
    [props.environmentId, props.threadId, props.workspaceRoot, navigation],
  );
  const resolveImageSource = useMarkdownImageSource({
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: props.workspaceRoot ?? null,
  });
  const onMarkdownImagePress = useCallback(
    (href: string) => {
      const media = resolveMarkdownMediaPreview(href, {
        environmentId: props.environmentId,
        threadId: props.threadId,
        workspaceRoot: props.workspaceRoot,
      });
      if (media?.kind === "image") setExpandedFile(media.source);
      else if (media?.kind === "video") setExpandedVideo(media.source);
      else onMarkdownLinkPress(href);
    },
    [onMarkdownLinkPress, props.environmentId, props.threadId, props.workspaceRoot],
  );
  const markdownLinkHandlers = useMemo<MarkdownLinkHandlers>(
    () => ({
      onLinkPress: onMarkdownLinkPress,
      onImagePress: onMarkdownImagePress,
      resolveImageSource,
      fileContextMenu: (href) => {
        const target = resolveFileChipTarget(href, props.workspaceRoot);
        return target ? fileChipMenu(target) : undefined;
      },
      onFileContextMenuAction: (href, actionId) => {
        const target = resolveFileChipTarget(href, props.workspaceRoot);
        if (!target) return;
        switch (actionId as FileChipAction) {
          case "copy-full-path":
            if (target.fullPath) copyTextWithHaptic(target.fullPath);
            return;
          case "copy-relative-path":
            if (target.relativePath) copyTextWithHaptic(target.relativePath);
            return;
          case "open-file":
            onMarkdownLinkPress(href);
            return;
          case "save":
            shareFileChip(target);
            return;
        }
      },
    }),
    [
      onMarkdownLinkPress,
      onMarkdownImagePress,
      props.workspaceRoot,
      resolveImageSource,
      shareFileChip,
    ],
  );
  const renderMarkdownImage = useCallback<MarkdownImageRenderer>(
    (image) => {
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
            format={
              /^(?:data:image\/svg\+xml[,;])|\.svg(?:$|[?#])/i.test(imageSource.uri)
                ? "svg"
                : undefined
            }
            sourceKey={imageSource.uri}
            unavailable={false}
            alt={image.alt}
            actionsSource={media?.source.actionsSource}
            onPressPreview={(source) => setExpandedFile((current) => current ?? source)}
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
          onPressPreview={(source) => setExpandedFile((current) => current ?? source)}
        />
      );
    },
    [props.environmentId, props.threadId, props.workspaceRoot],
  );
  const renderViewedImage = useCallback<MarkdownImageRenderer>(
    (image) => {
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
          onPressPreview={(source) => setExpandedFile((current) => current ?? source)}
        />
      ) : null;
    },
    [props.environmentId, props.threadId, props.workspaceRoot],
  );
  const markdownStyles = useMarkdownStyles();
  const reviewCommentColors = useReviewCommentColors();
  // One definition of "still live", shared with the fold derivation: two
  // copies of this test are what let a row and the fold beside it disagree.
  const unsettledTurnId = deriveUnsettledTurnId(props.latestTurn ?? null);
  // LegendList does not invalidate visible rows when only the renderItem closure changes.
  // Include turn completion so unchanged message rows reveal their footer and spacing
  // even when the final message update arrives before the turn settles.
  const listAppearanceData = useMemo(
    () => ({
      worktreeSetup: props.worktreeSetup,
      setupWorkingStartedAt: props.setupWorkingStartedAt,
      dispatchingMessageId: props.dispatchingMessageId,
      unsettledTurnId,
      copiedRowId,
      expandedWorkRows,
      expandedReasoningMessageIds,
      workRowSizing,
      iconSubtleColor,
      markdownStyles,
      reviewCommentColors,
      themeAppearance,
      userBubbleColor,
      viewportWidth,
    }),
    [
      props.worktreeSetup,
      props.setupWorkingStartedAt,
      props.dispatchingMessageId,
      unsettledTurnId,
      copiedRowId,
      expandedWorkRows,
      expandedReasoningMessageIds,
      workRowSizing,
      iconSubtleColor,
      markdownStyles,
      reviewCommentColors,
      themeAppearance,
      userBubbleColor,
      viewportWidth,
    ],
  );
  const reportHeaderMaterialVisibility = useCallback(
    (visible: boolean) => {
      if (headerMaterialVisibleRef.current === visible) {
        return;
      }
      headerMaterialVisibleRef.current = visible;
      props.onHeaderMaterialVisibilityChange?.(visible);
    },
    [props.onHeaderMaterialVisibilityChange],
  );
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // anchorTopInset, not topContentInset: under automatic insets the list
      // rests at contentOffset.y = -headerHeight (the inset lives only in
      // UIKit's adjustedContentInset, so topContentInset is 0 here). Add the
      // header height back or the material toggles a full header too late.
      reportHeaderMaterialVisibility(event.nativeEvent.contentOffset.y + anchorTopInset > 6);
      // LegendList recomputes its inset-aware end distance before invoking
      // this handler, so getState() is current. Only the actual end re-arms
      // follow: its broader maintain-scroll threshold is large enough for a
      // streaming chunk to pull a user back before their upward drag escapes.
      // A live user-scroll session still wins even if the first scroll event
      // remains inside LegendList's at-end tolerance.
      const listState = props.listRef.current?.getState();
      if (listState) {
        transitionEndFollow({
          type: "scroll",
          isAtEnd: listState.isAtEnd,
          userScrollSessionActive: userScrollSessionRef.current,
        });
      }
    },
    [reportHeaderMaterialVisibility, anchorTopInset, props.listRef, transitionEndFollow],
  );
  const clearUserScrollSettle = useCallback(() => {
    if (userScrollSettleTimerRef.current !== null) {
      clearTimeout(userScrollSettleTimerRef.current);
      userScrollSettleTimerRef.current = null;
    }
  }, []);
  const handleScrollBeginDrag = useCallback(() => {
    clearUserScrollSettle();
    userScrollSessionRef.current = true;
    // Pause before the first scroll event. Otherwise a stream update can run
    // maintainScrollAtEnd between touch-down and the drag leaving its threshold.
    transitionEndFollow({ type: "user-scroll-begin" });
  }, [clearUserScrollSettle, transitionEndFollow]);
  const finishUserScroll = useCallback(
    (releaseIsAtEnd?: boolean) => {
      clearUserScrollSettle();
      const userScrollSessionActive = userScrollSessionRef.current;
      userScrollSessionRef.current = false;
      transitionEndFollow({
        type: "user-scroll-end",
        // With no momentum, preserve the finger-release position. Streaming
        // growth during the native momentum-detection window must not turn a
        // release at the live edge into an opt-out from follow.
        isAtEnd: releaseIsAtEnd ?? props.listRef.current?.getState().isAtEnd ?? false,
        userScrollSessionActive,
      });
    },
    [clearUserScrollSettle, props.listRef, transitionEndFollow],
  );
  // Finger-lift velocity is not a reliable momentum signal: a gentle fling
  // can report zero and still decelerate. Give native momentum a short window
  // to announce itself; if it does, onMomentumScrollBegin cancels this fallback
  // and the session survives until the settled momentum-end position. This
  // mirrors the native-event handoff used by the home thread list's scroll gate.
  const handleScrollEndDrag = useCallback(() => {
    clearUserScrollSettle();
    const releaseIsAtEnd = props.listRef.current?.getState().isAtEnd ?? false;
    userScrollSettleTimerRef.current = setTimeout(() => finishUserScroll(releaseIsAtEnd), 160);
  }, [clearUserScrollSettle, finishUserScroll, props.listRef]);
  const handleMomentumScrollBegin = useCallback(() => {
    if (userScrollSessionRef.current) {
      clearUserScrollSettle();
    }
  }, [clearUserScrollSettle]);
  const handleMomentumScrollEnd = useCallback(() => {
    finishUserScroll();
  }, [finishUserScroll]);

  useEffect(() => clearUserScrollSettle, [clearUserScrollSettle]);

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
    setViewportHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
  }, []);

  // Thread identity is env-scoped: two environments can hold the same
  // ThreadId, and keying resets (or the list mount) on the bare id would
  // carry stale scroll/follow state across an environment switch.
  const feedThreadKey = scopedThreadKey(props.environmentId, props.threadId);
  // Virtualized groups can unmount without losing the reader's place. This cache
  // belongs to this thread view only and never causes per-scroll React updates.
  const workGroupScrollPositions = useMemo(
    () => new Map<string, ThreadWorkGroupScrollPosition>(),
    [feedThreadKey],
  );

  useEffect(() => {
    reportHeaderMaterialVisibility(false);
  }, [feedThreadKey, reportHeaderMaterialVisibility]);

  // A thread switch opens pinned to the end; a send explicitly returns to the
  // live edge (ThreadDetailScreen scrolls the new message into place). Both
  // re-arm follow regardless of where the user had scrolled before.
  useEffect(() => {
    clearUserScrollSettle();
    userScrollSessionRef.current = false;
    transitionEndFollow({ type: "reset" });
  }, [clearUserScrollSettle, feedThreadKey, transitionEndFollow]);
  useEffect(() => {
    if (props.submittedMessageId !== null) {
      clearUserScrollSettle();
      userScrollSessionRef.current = false;
      transitionEndFollow({ type: "reset" });
    }
  }, [clearUserScrollSettle, props.submittedMessageId, transitionEndFollow]);

  const expandedWorkGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [groupId, expanded] of Object.entries(expandedWorkGroups)) {
      if (expanded) {
        ids.add(groupId);
      }
    }
    return ids;
  }, [expandedWorkGroups]);
  const presentedFeed = useMemo(
    () =>
      appendPendingThreadMessages(
        deriveThreadFeedPresentation(
          props.feed,
          props.latestTurn,
          expandedTurnIds,
          expandedWorkGroupIds,
          props.activeWorkStartedAt,
        ),
        props.feed,
        props.queuedMessages,
      ),
    [
      props.queuedMessages,
      expandedTurnIds,
      expandedWorkGroupIds,
      props.activeWorkStartedAt,
      props.feed,
      props.latestTurn,
    ],
  );
  const setupAnchorIndex = presentedFeed.findIndex(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  // The empty↔filled key below remounts the list and resets its imperative
  // content-inset override. Seed the fresh instance synchronously with the
  // current overlay height before the scroll integration's next reaction;
  // on Android the declarative contentInset floor covers this same window.
  const listMountKey = `${feedThreadKey}:${presentedFeed.length === 0 ? "empty" : "filled"}`;
  useLayoutEffect(() => {
    const bottom = props.contentInsetEndAdjustment.value;
    if (bottom > 0) {
      props.listRef.current?.reportContentInset({ bottom });
    }
  }, [listMountKey, props.contentInsetEndAdjustment, props.listRef]);

  const anchoredEndSpace = useMemo(
    () =>
      resolveChatListAnchoredEndSpace(
        presentedFeed,
        props.anchorMessageId,
        (entry) => (entry.type === "message" && entry.message.role === "user" ? entry.id : null),
        { anchorOffset: anchorTopInset + CHAT_LIST_ANCHOR_OFFSET },
      ),
    [presentedFeed, props.anchorMessageId, anchorTopInset],
  );
  const terminalAssistantMessageIds = useMemo(() => {
    const terminalIdsByTurn = new Map<TurnId, string>();
    for (const entry of props.feed) {
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {
        terminalIdsByTurn.set(entry.message.turnId, entry.message.id);
      }
    }
    return new Set(terminalIdsByTurn.values());
  }, [props.feed]);
  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = props.latestTurn;
    if (!props.latestTurn || !previous) {
      return;
    }
    if (props.latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && props.latestTurn.state === "interrupted") {
        const interruptedTurnId = props.latestTurn.turnId;
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(interruptedTurnId),
        }));
      }
      return;
    }
    setInteractionState((current) => {
      if (!current.expandedTurnIds.has(previous.turnId)) {
        return current;
      }
      const next = new Set(current.expandedTurnIds);
      next.delete(previous.turnId);
      return { ...current, expandedTurnIds: next };
    });
  }, [props.latestTurn]);

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

  const settleDisclosureAfterLayout = useCallback(() => {
    if (disclosureSettleFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    if (disclosureSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
    }
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        // A disclosure can leave the reader above the end without a drag.
        // Reconcile follow before a later layout or resume can re-pin it.
        const listState = props.listRef.current?.getState();
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
  }, [props.listRef, transitionEndFollow]);

  const suspendEndScrollMaintenanceForDisclosure = useCallback((anchorKey: string | null) => {
    disclosureAnchorKeyRef.current = anchorKey;
    setDisclosureToggleSettling(true);
  }, []);

  // Start the quiet-frame countdown after React has committed the disclosure.
  // Every measured item-size change restarts it, so end maintenance cannot
  // wake between the data mutation and LegendList's final layout correction.
  useLayoutEffect(() => {
    if (disclosureAnchorKeyRef.current !== null) {
      settleDisclosureAfterLayout();
    }
  }, [
    expandedTurnIds,
    expandedWorkGroups,
    expandedWorkRows,
    expandedReasoningMessageIds,
    settleDisclosureAfterLayout,
  ]);

  const handleItemSizeChanged = useCallback(() => {
    if (disclosureAnchorKeyRef.current !== null) {
      settleDisclosureAfterLayout();
    }
  }, [settleDisclosureAfterLayout]);

  const shouldRestoreVisibleContentPosition = useCallback((entry: ThreadFeedEntry) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || entry.id === disclosureAnchorKey;
  }, []);

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );

  const onCopyWorkRow = useCallback((rowId: string, value: string) => {
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
  }, []);

  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorKey: string) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey);
      setInteractionState((current) => ({
        ...current,
        expandedWorkGroups: {
          ...current.expandedWorkGroups,
          [groupId]: !(current.expandedWorkGroups[groupId] ?? false),
        },
      }));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleWorkRow = useCallback(
    (rowId: string, anchorKey: string) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey);
      setInteractionState((current) => ({
        ...current,
        expandedWorkRows: {
          ...current.expandedWorkRows,
          [rowId]: !(current.expandedWorkRows[rowId] ?? false),
        },
      }));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleTurnFold = useCallback(
    (turnId: TurnId) => {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${turnId}`);
      setInteractionState((current) => {
        const next = new Set(current.expandedTurnIds);
        if (next.has(turnId)) {
          next.delete(turnId);
        } else {
          next.add(turnId);
        }
        return { ...current, expandedTurnIds: next };
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleReasoning = useCallback(
    (messageId: string) => {
      // Reasoning details use their own row within the expanded activity history.
      suspendEndScrollMaintenanceForDisclosure(messageId);
      setInteractionState((current) => {
        const next = new Set(current.expandedReasoningMessageIds);
        if (next.has(messageId)) {
          next.delete(messageId);
        } else {
          next.add(messageId);
        }
        return { ...current, expandedReasoningMessageIds: next };
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onPressPreview = useCallback((source: FilePreviewSource) => {
    setExpandedFile((current) => current ?? source);
  }, []);
  const onPressVideo = useCallback(
    (attachment: ChatFileAttachment, sourceIdentifier: string) => {
      setExpandedVideo(
        (current) =>
          current ??
          attachmentVideoPreviewSource(props.environmentId, attachment, sourceIdentifier),
      );
    },
    [props.environmentId],
  );

  // Rows whose height is known before they ever render. Without this, every
  // row above the viewport is assumed to be estimatedItemSize tall, and
  // scrolling up through unmeasured content corrects each row's height as it
  // mounts — the feed visibly jumps. Fixed sizes make the small chrome rows
  // exact; message rows stay undefined and use LegendList's per-type running
  // average once one of their type has been measured.
  const getFixedItemSize = useCallback(
    (entry: ThreadFeedEntry) => {
      if (workRowSizing.fixedRowHeight === undefined) {
        return undefined;
      }
      switch (entry.type) {
        case "message":
          // A collapsed reasoning row is the same chrome as a work toggle.
          return entry.message.role === "reasoning" && !expandedReasoningMessageIds.has(entry.id)
            ? WORK_GROUP_TOGGLE_HEIGHT
            : undefined;
        case "turn-fold":
          return TURN_FOLD_HEIGHT;
        case "work-toggle":
        case "thinking":
          return WORK_GROUP_TOGGLE_HEIGHT;
        case "activity-group":
          if (isContextCompactionActivityGroup(entry)) {
            return undefined;
          }
          // Expanded rows append a variable detail block — fall back to
          // measurement for those groups.
          return entry.activities.some((activity) => expandedWorkRows[activity.id])
            ? undefined
            : collapsedWorkLogHeight(entry.activities);
        default:
          return undefined;
      }
    },
    [expandedReasoningMessageIds, expandedWorkRows, workRowSizing.fixedRowHeight],
  );

  // Disclosures can mount existing offscreen rows as well as new work rows.
  // Fade those in after movement; never retain removed rows over replacements.
  const renderItem = useCallback(
    (info: { item: PendingThreadFeedEntry; index: number }) => (
      <Animated.View
        key={info.item.id}
        entering={disclosureToggleSettling ? THREAD_FEED_DISCLOSURE_ENTER_TRANSITION : undefined}
      >
        <ThreadMediaVisibility>
          {renderFeedEntry(info, {
            environmentId: props.environmentId,
            dispatchingMessageId: props.dispatchingMessageId,
            onEditPendingMessage: props.onEditPendingMessage,
            copiedRowId,
            expandedWorkRows,
            expandedReasoningMessageIds,
            workRowSizing,
            workGroupScrollPositions,
            terminalAssistantMessageIds,
            unsettledTurnId,
            isWorking: props.activeWorkStartedAt !== null,
            onCopyWorkRow,
            onToggleWorkGroup,
            onToggleWorkRow,
            onToggleTurnFold,
            onToggleReasoning,
            onPressPreview,
            onPressVideo,
            markdownLinkHandlers,
            renderMarkdownImage,
            renderViewedImage,
            iconSubtleColor,
            screenColor,
            userBubbleColor,
            markdownStyles,
            reviewCommentColors,
            reviewCommentBubbleWidth,
            themeAppearance,
            userBubbleMaxWidth,
            markdownContentWidth,
            skills: props.skills,
            onUseArtifactTemplate: props.onUseArtifactTemplate,
          })}
          {props.worktreeSetup && info.index === setupAnchorIndex ? (
            <WorktreeSetupCard key={props.threadId} {...props.worktreeSetup} />
          ) : props.setupWorkingStartedAt && info.index === setupAnchorIndex ? (
            <WorktreeWorkingHeader startedAt={props.setupWorkingStartedAt} />
          ) : null}
        </ThreadMediaVisibility>
      </Animated.View>
    ),
    [
      props.worktreeSetup,
      props.setupWorkingStartedAt,
      props.threadId,
      setupAnchorIndex,
      props.dispatchingMessageId,
      props.onEditPendingMessage,
      copiedRowId,
      disclosureToggleSettling,
      expandedWorkRows,
      expandedReasoningMessageIds,
      workRowSizing,
      workGroupScrollPositions,
      terminalAssistantMessageIds,
      unsettledTurnId,
      props.activeWorkStartedAt,
      iconSubtleColor,
      screenColor,
      userBubbleColor,
      markdownStyles,
      reviewCommentColors,
      reviewCommentBubbleWidth,
      themeAppearance,
      userBubbleMaxWidth,
      markdownContentWidth,
      onCopyWorkRow,
      markdownLinkHandlers,
      onPressPreview,
      onPressVideo,
      onToggleReasoning,
      onToggleTurnFold,
      onToggleWorkGroup,
      onToggleWorkRow,
      props.environmentId,
      props.onUseArtifactTemplate,
      props.skills,
      renderMarkdownImage,
      renderViewedImage,
    ],
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
            ref={props.listRef}
            // The empty↔filled key remounts the list when messages first
            // arrive. LegendList's maintainScrollAtEnd calls scrollToEnd(),
            // which is blind to UIKit's adjustedContentInset — inserting into
            // an already-attached list under a transparent header can pin
            // short content at offset 0 (one header-height too high). A fresh
            // mount positions during attach, where UIKit applies the inset.
            key={listMountKey}
            style={{ flex: 1 }}
            // RN 0.81+ drops touches inside the contentInset area
            // (facebook/react-native#54123); the anchored end space after a send
            // is pure inset, so without this the blank region can't be scrolled.
            applyWorkaroundForContentInsetHitTestBug
            contentInsetAdjustmentBehavior={usesNativeAutomaticInsets ? "automatic" : "never"}
            automaticallyAdjustsScrollIndicatorInsets={usesNativeAutomaticInsets}
            {...(usesNativeAutomaticInsets
              ? {
                  // Do NOT pass a manual `contentInset` here. Like the Home
                  // ScrollView, we rely purely on `contentInsetAdjustmentBehavior:
                  // "automatic"` so UIKit derives the top inset from the transparent
                  // header. A manual contentInset (which LegendList consumes into its
                  // own layout math) collapses the scroll view's adjustedContentInset
                  // top to 0, leaving the iOS 26/27 scroll-edge effect no region to
                  // render into — which is why the header blur was missing on threads.
                  scrollIndicatorInsets: { top: 0, left: 0, right: 0, bottom: 0 },
                }
              : { scrollIndicatorInsets: { top: topContentInset, bottom: 0 } })}
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            // Patched LegendList prop (patches/@legendapp__list@3.3.5.patch):
            // lets its scroll math clamp programmatic scrolls to -headerInset
            // instead of 0, so initialScrollAtEnd/maintainScrollAtEnd on short
            // content rest below the transparent header rather than at frame top.
            contentInsetStartAdjustment={usesNativeAutomaticInsets ? anchorTopInset : 0}
            contentInsetEndAdjustment={props.contentInsetEndAdjustment}
            // UIKit's automatic behavior adds the safe-area bottom on top of the
            // raw contentInset the keyboard integration writes. The detail screen
            // under-reports the composer inset by this amount (see
            // ThreadDetailScreen); this tells LegendList's scroll math about the
            // extra so programmatic end scrolls land at the true resting offset.
            contentInsetEndStaticAdjustment={usesNativeAutomaticInsets ? insets.bottom : 0}
            // Android: the composer overlay only exists as the keyboard
            // integration's animated bottom padding, which the list's scroll
            // math cannot see until the inset reports above land — and those
            // arrive via runOnJS, racing the remounted list's one-shot initial
            // scroll-at-end. Seed the estimated overlay height as a declarative
            // contentInset floor: LegendList consumes it in JS math only
            // (Android's ScrollView has no native contentInset prop) and the
            // first reported override REPLACES it instead of adding to it.
            // Not on iOS: there the prop would reach UIKit and inset natively
            // on top of the animated padding.
            {...(initialContentInset ? { contentInset: initialContentInset } : {})}
            // The keyboard integration's offset math (end pinning, max scroll)
            // must add the same UIKit-added extra, or its keyboard-open end
            // targets land one safe-area short of the true resting offset.
            adjustedInsetCompensation={usesNativeAutomaticInsets ? insets.bottom : 0}
            freeze={props.freeze}
            // Follow the measured end immediately. Animating toward an estimated
            // end races row measurement when a pending message is acknowledged.
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
            maintainVisibleContentPosition={
              endFollowEnabled && !disclosureToggleSettling ? false : maintainVisibleContentPosition
            }
            data={presentedFeed}
            extraData={listAppearanceData}
            renderItem={renderItem}
            viewabilityConfig={THREAD_MEDIA_VIEWABILITY_CONFIG}
            keyExtractor={(entry) => entry.id}
            getItemType={(entry) =>
              entry.type === "message" ? `message:${entry.message.role}` : entry.type
            }
            getFixedItemSize={getFixedItemSize}
            // Virtualized rows must move with their measurements. Native layout
            // transitions can retain stale positions during sync, even at duration 0.
            onItemSizeChanged={handleItemSizeChanged}
            // Measure rows well before they scroll into view so estimate→actual
            // corrections land offscreen instead of under the user's finger.
            drawDistance={500}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            keyboardLiftBehavior="whenAtEnd"
            // Seed the list's scroll math with the real viewport before its own
            // onLayout: the empty→filled remount can then tell at mount that
            // short content underflows the viewport and skip programmatic
            // positioning entirely (any offset write during screen attach races
            // UIKit's adjustedContentInset application and lands high or low).
            {...(viewportHeight > 0 && viewportWidth > 0
              ? { estimatedListSize: { height: viewportHeight, width: viewportWidth } }
              : {})}
            // RN's native scrollTo command clamps targets to a floor of
            // -contentInset.top using the RAW inset — under automatic insets the
            // header inset only exists in adjustedContentInset, so scrolls to
            // negative offsets (content top below the transparent header) get
            // clamped to 0. This prop disables that clamp; UIKit still bounces
            // user overscroll back to the adjusted rest position.
            scrollToOverflowEnabled
            estimatedItemSize={180}
            // Chat-style bottom alignment: when a thread is shorter than the
            // viewport, pad above the content so messages rest just above the
            // composer instead of under the header. No effect on threads that
            // overflow the viewport (the padding clamps to zero).
            alignItemsAtEnd
            initialScrollAtEnd
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
                {props.loadEarlier != null ? (
                  <Pressable
                    onPress={props.loadEarlier.onLoadEarlier}
                    disabled={props.loadEarlier.loading}
                    className="items-center py-2"
                  >
                    <Text className="text-xs text-foreground-secondary">
                      {props.loadEarlier.loading ? "Loading earlier turns…" : "Load earlier turns"}
                    </Text>
                  </Pressable>
                ) : null}
              </>
            }
            contentContainerStyle={{
              paddingTop: 12,
              paddingHorizontal: contentHorizontalPadding,
            }}
          />
        </View>
        {presentedFeed.length === 0 &&
        !props.worktreeSetup &&
        props.activeWorkStartedAt === null &&
        props.contentPresentation.kind === "ready" ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
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
