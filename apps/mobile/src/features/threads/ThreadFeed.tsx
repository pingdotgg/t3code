import * as Haptics from "expo-haptics";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { useViewabilityAmount, type LegendListRef } from "@legendapp/list/react-native";
import type {
  ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";
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
import { videoMimeType } from "@t3tools/shared/video";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  createContext,
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
  Markdown,
  type CustomRenderers,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import {
  ActivityIndicator,
  Alert,
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
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { isPdfFile } from "../../lib/filePreview";
import { PresentationSource } from "../../components/NativePresentation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  FadeIn,
  FadeInUp,
  LinearTransition,
  type SharedValue,
} from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { useFontFamily } from "../../lib/useFontFamily";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { hasWideMarkdownBlock } from "../../lib/wideMarkdownBlocks";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type MarkdownFileContextMenu,
  type MarkdownImageRenderer,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";

import { AppText as Text } from "../../components/AppText";
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
import { CopyTextButton } from "../../components/CopyTextButton";
import {
  parseReviewCommentMessageSegments,
  type ReviewInlineComment,
} from "../review/reviewCommentSelection";
import type { ReviewDiffTheme } from "../review/shikiReviewHighlighter";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { cn } from "../../lib/cn";
import {
  deriveCenteredContentHorizontalPadding,
  deriveThreadFeedInitialContentInset,
  deriveThreadWorkLogSizing,
  type LayoutVariant,
} from "../../lib/layout";
import {
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
} from "../../lib/appearancePreferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { markdownFileIconSource } from "@t3tools/mobile-markdown-text/file-icons";
import {
  normalizeNativeMarkdownUrl,
  resolveMarkdownInlineCodePresentation,
  resolveMarkdownLinkPresentation,
} from "@t3tools/mobile-markdown-text/links";
import {
  deriveThreadFeedPresentation,
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
  ThreadDisclosureChevron,
  ThreadWorkGroupToggle,
  ThreadWorkLog,
  THREAD_DISCLOSURE_TRANSITION_MS,
  WORK_GROUP_TOGGLE_HEIGHT,
} from "./thread-work-log";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";
import {
  assetEnvironment,
  useAssetUrl,
  useAssetUrlState,
  useRefreshAssetUrl,
} from "../../state/assets";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { usePreparedConnection } from "../../state/session";
import * as Option from "effect/Option";
import {
  basename,
  fileRoutePathSegments,
  isAbsolutePath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";
import { fileChipMenu, resolveFileChipTarget, type FileChipAction } from "./fileChipMenu";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";

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
const THREAD_FEED_LAYOUT_TRANSITION = LinearTransition.duration(THREAD_DISCLOSURE_TRANSITION_MS);
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
        <Image source={{ uri }} className={props.className} resizeMode="cover" />
      </Pressable>
    </PresentationSource>
  );
}

// The attachment union has an open member (`type: string` for attachment
// types from newer servers), so literal comparisons do not narrow it. Split
// with guards and render unknown types as inert rows, never crash.
function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {
  return attachment.type === "image";
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
            : shareFile(sourceIdentifier)
        }
      >
        <View className="h-12 w-10 shrink-0 items-center justify-center rounded-lg bg-subtle">
          {opening ? (
            <ActivityIndicator size="small" />
          ) : (
            <SymbolView
              name="doc.text"
              size={26}
              tintColorClassName={isPdf ? "accent-red-500" : "accent-foreground-muted"}
              type="monochrome"
            />
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
  );
}

/**
 * An attachment type this build does not know (newer server). Rendered as an
 * inert row: the name is still useful, but there is nothing to open.
 */
function MessageAttachmentUnknown(props: { readonly name: string }) {
  return (
    <View className="flex-row items-center gap-2 py-1">
      <SymbolView name="doc.text" size={16} tintColor="#a3a3a3" type="monochrome" />
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {props.name}
      </Text>
    </View>
  );
}

const ThreadMediaVisibleContext = createContext(false);
// LegendList only computes hook visibility when the list has a viewability config.
const THREAD_MEDIA_VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0 };

function ThreadMediaVisibility(props: { readonly children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useViewabilityAmount<ThreadFeedEntry>(
    useCallback((token) => setVisible(token.sizeVisible > 0), []),
  );
  return <ThreadMediaVisibleContext value={visible}>{props.children}</ThreadMediaVisibleContext>;
}

function ThreadMarkdownVideo(props: { readonly source: MediaVideoPreviewSource }) {
  const { source } = props;
  const visible = useContext(ThreadMediaVisibleContext);
  const thumbnailKey = mediaVideoThumbnailKey(source);
  const asset = useAssetUrlState(
    "environmentId" in source ? source.environmentId : null,
    "resource" in source ? source.resource : null,
  );
  const refreshAssetUrl = useRefreshAssetUrl(
    "environmentId" in source ? source.environmentId : null,
    "resource" in source ? source.resource : null,
  );
  const uri = mediaVideoPreviewUri(source, asset._tag === "Success" ? asset.url : null);
  return (
    <MediaVideoPlayer
      key={thumbnailKey}
      uri={uri}
      resolvePlaybackUri={
        "resource" in source
          ? async () => mediaVideoPreviewUri(source, await refreshAssetUrl())
          : undefined
      }
      name={source.name}
      thumbnailKey={thumbnailKey}
      thumbnailVisible={visible}
      unavailable={"resource" in source && asset._tag === "Failure"}
      actionsSource={source.actionsSource}
    />
  );
}

const MARKDOWN_MONO_FONT = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});

interface MarkdownStyleSets {
  readonly user: MarkdownStyleSet;
  readonly assistant: MarkdownStyleSet;
}

interface MarkdownStyleSet {
  readonly theme: PartialMarkdownTheme;
  readonly styles: NodeStyleOverrides;
  readonly renderers: CustomRenderers;
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

interface ReviewCommentColors {
  readonly background: ColorValue;
  readonly border: ColorValue;
  readonly mutedBackground: ColorValue;
  readonly text: ColorValue;
  readonly mutedText: ColorValue;
  readonly codeBackground: ColorValue;
}

const failedMarkdownFaviconHosts = new Set<string>();
const MarkdownLinkLabelContext = createContext(false);
const markdownLinkStyles = StyleSheet.create({
  inlineIcon: {
    width: 14,
    height: 14,
    marginHorizontal: 3,
    transform: [{ translateY: 2 }],
  },
  favicon: {
    borderRadius: 3,
  },
});

const MarkdownExternalLink = memo(function MarkdownExternalLink(props: {
  readonly children: ReactNode;
  readonly color: string;
  readonly host: string;
  readonly href: string;
  readonly onPress: (href: string) => void;
}) {
  const [failed, setFailed] = useState(() => failedMarkdownFaviconHosts.has(props.host));

  return (
    <NativeText
      className="font-sans"
      onPress={() => props.onPress(props.href)}
      style={{
        color: props.color,
        textDecorationLine: "none",
      }}
    >
      {!failed ? (
        <Image
          source={{
            uri: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(props.host)}&sz=32`,
          }}
          style={[markdownLinkStyles.inlineIcon, markdownLinkStyles.favicon]}
          onError={() => {
            failedMarkdownFaviconHosts.add(props.host);
            setFailed(true);
          }}
        />
      ) : (
        <NativeText style={{ color: props.color }}>{" ◉ "}</NativeText>
      )}
      {props.children}
    </NativeText>
  );
});

function MarkdownInlineCode(props: {
  readonly content: string;
  readonly textColor: string;
  readonly codeColor: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly onLinkPress: (href: string) => void;
}) {
  const insideLink = useContext(MarkdownLinkLabelContext);
  const presentation = insideLink ? null : resolveMarkdownInlineCodePresentation(props.content);
  return (
    <NativeText
      className={presentation ? "font-t3-bold" : "font-mono"}
      onPress={presentation ? () => props.onLinkPress(presentation.href) : undefined}
      style={{
        color: presentation ? props.textColor : props.codeColor,
        fontSize: props.fontSize,
        lineHeight: props.lineHeight,
      }}
    >
      {presentation ? (
        <Image
          source={markdownFileIconSource(presentation.icon)}
          style={markdownLinkStyles.inlineIcon}
        />
      ) : null}
      {presentation?.label ?? props.content}
    </NativeText>
  );
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
  readonly onLinkPress: (href: string) => void;
  readonly fileContextMenu: (href: string) => MarkdownFileContextMenu | undefined;
  readonly onFileContextMenuAction: (href: string, actionId: string) => void;
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
    return hasNativeSelectableMarkdownText() ? (
      <SelectableMarkdownText
        key={`markdown:${segment.sourceOffset}`}
        markdown={markdown}
        skills={props.skills}
        textStyle={props.markdownStyles.nativeTextStyle}
        {...props.linkHandlers}
        renderImage={props.renderImage}
      />
    ) : (
      <Markdown
        key={`markdown:${segment.sourceOffset}`}
        options={{ gfm: true }}
        renderers={props.markdownStyles.renderers}
        styles={props.markdownStyles.styles}
        theme={props.markdownStyles.theme}
      >
        {markdown}
      </Markdown>
    );
  });
});

function MarkdownCodeBlock(props: {
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly content: string;
  readonly copyTintColor: ColorValue;
  readonly headerTextColor: string;
  readonly fontSize: number;
  readonly highlightCode: boolean;
  readonly language?: string | null;
  readonly lineHeight: number;
  readonly textColor: string;
  readonly theme: ReviewDiffTheme;
}) {
  const content = props.content.replace(/\n$/, "");
  const languageLabel = props.language?.trim() || "text";
  const highlighted = useMarkdownCodeHighlight({
    code: content,
    enabled: props.highlightCode && Boolean(props.language?.trim()),
    language: props.language,
    theme: props.theme,
  });
  let tokenOffset = 0;

  return (
    <View
      className="my-3 min-w-0 max-w-full self-stretch overflow-hidden rounded-lg border"
      style={{ backgroundColor: props.backgroundColor, borderColor: props.borderColor }}
    >
      <View
        className="flex-row items-center justify-between gap-2 border-b py-1 pr-1.5 pl-3.5"
        style={{ borderBottomColor: props.borderColor }}
      >
        <NativeText
          className="flex-1 font-mono uppercase opacity-70"
          numberOfLines={1}
          style={{
            color: props.headerTextColor,
            fontSize: props.fontSize,
            ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
          }}
        >
          {languageLabel}
        </NativeText>
        <CopyTextButton
          accessibilityLabel="Copy code"
          text={content}
          tintColor={props.copyTintColor}
          buttonSize={32}
          iconSize={16}
        />
      </View>
      <ScrollView
        horizontal
        bounces={false}
        nestedScrollEnabled={Platform.OS === "android"}
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="px-3.5 py-3"
      >
        <NativeText
          selectable
          className="font-mono"
          style={{
            color: props.textColor,
            fontSize: props.fontSize,
            lineHeight: props.lineHeight,
            ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
          }}
        >
          {highlighted
            ? highlighted.map((line, lineIndex) => {
                const lineStartOffset = tokenOffset;
                const lineText = line.map((token) => token.content).join("");
                const renderedLine = (
                  <NativeText key={`line:${lineStartOffset}:${lineText}`}>
                    {line.map((token) => {
                      const startOffset = tokenOffset;
                      tokenOffset += token.content.length;
                      const fontStyle =
                        token.fontStyle !== null && (token.fontStyle & 1) === 1
                          ? ("italic" as const)
                          : ("normal" as const);
                      const fontWeight =
                        token.fontStyle !== null && (token.fontStyle & 2) === 2
                          ? ("700" as const)
                          : ("400" as const);

                      return (
                        <NativeText
                          key={`${startOffset}:${token.content}:${token.color ?? ""}:${
                            token.fontStyle ?? ""
                          }`}
                          style={{
                            color: token.color ?? props.textColor,
                            fontStyle,
                            fontWeight,
                          }}
                        >
                          {token.content}
                        </NativeText>
                      );
                    })}
                    {lineIndex + 1 < highlighted.length ? "\n" : ""}
                  </NativeText>
                );
                if (lineIndex + 1 < highlighted.length) {
                  tokenOffset += 1;
                }
                return renderedLine;
              })
            : content}
        </NativeText>
      </ScrollView>
    </View>
  );
}

function useReviewCommentColors(): ReviewCommentColors {
  const theme = useUniwindTheme();

  return useMemo(
    () => ({
      background: theme["--color-card"],
      border: theme["--color-border"],
      mutedBackground: theme["--color-subtle"],
      text: theme["--color-foreground"],
      mutedText: theme["--color-foreground-muted"],
      codeBackground: theme["--color-md-code-bg"],
    }),
    [theme],
  );
}

function useMarkdownStyles(
  onLinkPress: (href: string) => void,
  renderImage: MarkdownImageRenderer,
): MarkdownStyleSets {
  const { appearance, themeAppearance } = useAppearancePreferences();
  const markdownFontSizes = useMemo(
    () => resolveMarkdownFontSizes(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const themeMode = themeAppearance;
  const theme = useUniwindTheme();
  const markdownBodyColor = theme["--color-md-body"];
  const markdownStrongColor = theme["--color-md-strong"];
  const markdownLinkColor = theme["--color-md-link"];
  const markdownBlockquoteBg = theme["--color-md-blockquote-bg"];
  const markdownBlockquoteBorder = theme["--color-md-blockquote-border"];
  const markdownCodeBg = theme["--color-md-code-bg"];
  const markdownCodeText = theme["--color-md-code-text"];
  const markdownInlineCodeText = theme["--color-foreground-secondary"];
  const markdownHrColor = theme["--color-md-hr"];
  const markdownUserBodyColor = theme["--color-user-bubble-foreground"];
  const markdownUserCodeBg = theme["--color-md-user-code-bg"];
  const markdownUserCodeText = theme["--color-md-user-code-text"];
  const markdownUserInlineCodeText = theme["--color-user-bubble-foreground-muted"];
  const markdownUserFenceBg = theme["--color-md-user-fence-bg"];
  const markdownUserFenceText = theme["--color-md-user-fence-text"];
  const iconSubtleColor = theme["--color-icon-subtle"];
  const inlineSkillForeground = theme["--color-inline-skill-foreground"];
  const userBubbleSkillForeground = theme["--color-user-bubble-skill-foreground"];
  const userBubbleForegroundMuted = theme["--color-user-bubble-foreground-muted"];
  const regularFontFamily = useFontFamily("regular");
  const boldFontFamily = useFontFamily("bold");

  return useMemo(() => {
    const baseTheme: PartialMarkdownTheme = {
      colors: {
        text: markdownBodyColor,
        heading: markdownStrongColor,
        link: markdownLinkColor,
        blockquote: markdownBlockquoteBorder,
        border: markdownHrColor,
        surface: "transparent",
        surfaceLight: markdownBlockquoteBg,
        accent: markdownLinkColor,
        tableBorder: markdownHrColor,
        tableHeader: markdownBlockquoteBg,
        tableHeaderText: markdownStrongColor,
        tableRowOdd: "transparent",
        tableRowEven: "transparent",
      },
      spacing: {
        xs: 4,
        s: 4,
        m: 8,
        l: 8,
        xl: 16,
      },
      fontSizes: {
        s: markdownFontSizes.s,
        m: markdownFontSizes.m,
        h1: markdownFontSizes.h1,
        h2: markdownFontSizes.h2,
        h3: markdownFontSizes.h3,
        h4: markdownFontSizes.h4,
        h5: markdownFontSizes.h5,
        h6: markdownFontSizes.h6,
      },
      fontFamilies: {
        regular: regularFontFamily,
        heading: boldFontFamily,
        mono: MARKDOWN_MONO_FONT,
      },
      headingWeight: "700",
      borderRadius: {
        s: 4,
        m: 8,
        l: 12,
      },
      showCodeLanguage: false,
    };

    const baseStyles: NodeStyleOverrides = {
      document: { flexShrink: 1 },
      paragraph: { marginTop: 0, marginBottom: 10 },
      list: { marginTop: 4, marginBottom: 8 },
      list_item: { marginTop: 0, marginBottom: 4 },
      task_list_item: { marginTop: 0, marginBottom: 4 },
      text: { lineHeight: markdownFontSizes.bodyLineHeight },
      bold: {
        fontWeight: "700",
        color: markdownStrongColor,
        fontFamily: boldFontFamily,
      },
      italic: { fontStyle: "italic" },
      link: {
        color: markdownLinkColor,
        textDecorationLine: "underline" as const,
      },
      blockquote: {
        borderLeftWidth: 2,
        borderLeftColor: markdownBlockquoteBorder,
        paddingLeft: 11,
        paddingVertical: 2,
        marginLeft: 0,
        marginVertical: 10,
      },
      heading: {
        fontFamily: boldFontFamily,
        color: markdownStrongColor,
        marginTop: 18,
        marginBottom: 8,
      },
      horizontal_rule: {
        backgroundColor: markdownHrColor,
        height: 1,
        marginVertical: 12,
      },
    };

    const createMarkdownRenderers = (
      inlineTextColor: string,
      inlineCodeTextColor: string,
      blockBackgroundColor: string,
      blockTextColor: string,
      copyTintColor: ColorValue,
      preserveSoftBreaks: boolean,
      highlightCode: boolean,
    ): CustomRenderers => ({
      link: ({ children, href = "" }) => {
        const presentation = resolveMarkdownLinkPresentation(href);
        if (presentation.kind === "file") {
          return (
            <NativeText
              className="font-t3-bold"
              onPress={() => onLinkPress(href)}
              style={{ color: inlineTextColor }}
            >
              <Image
                source={markdownFileIconSource(presentation.icon)}
                style={markdownLinkStyles.inlineIcon}
              />
              {presentation.label}
            </NativeText>
          );
        }
        if (presentation.kind === "external") {
          return (
            <MarkdownLinkLabelContext.Provider value>
              <MarkdownExternalLink
                href={presentation.href}
                host={presentation.host}
                color={markdownLinkColor}
                onPress={onLinkPress}
              >
                {children}
              </MarkdownExternalLink>
            </MarkdownLinkLabelContext.Provider>
          );
        }
        const linkHref = presentation.href;
        return (
          <MarkdownLinkLabelContext.Provider value>
            <NativeText
              className="underline"
              onPress={
                linkHref
                  ? () => {
                      void tryOpenExternalUrl(linkHref, "markdown-link");
                    }
                  : undefined
              }
              style={{ color: markdownLinkColor }}
            >
              {children}
            </NativeText>
          </MarkdownLinkLabelContext.Provider>
        );
      },
      list: ({ node, Renderer, ordered = false, start = 1 }) => (
        <View className="mt-0.5 mb-2">
          {node.children?.map((child, index) => {
            const childKey = `${child.type}:${child.beg ?? "unknown"}:${child.end ?? "unknown"}`;
            if (child.type === "task_list_item") {
              return (
                <Renderer key={childKey} node={child} depth={1} inListItem parentIsText={false} />
              );
            }
            return (
              <View className="mb-[3px] flex-row items-start" key={childKey}>
                <NativeText
                  className="font-sans"
                  style={{
                    width: ordered ? 22 : 12,
                    marginRight: 5,
                    color: inlineTextColor,
                    fontSize: markdownFontSizes.m,
                    lineHeight: markdownFontSizes.bodyLineHeight,
                    textAlign: ordered ? "right" : "center",
                  }}
                >
                  {ordered ? `${start + index}.` : "•"}
                </NativeText>
                <View className="min-w-0 flex-1">
                  <Renderer node={child} depth={1} inListItem parentIsText={false} />
                </View>
              </View>
            );
          })}
        </View>
      ),
      image: ({ node }) =>
        node.href
          ? (renderImage({
              href: node.href,
              alt: node.alt ?? null,
              title: node.title ?? null,
            }) ?? undefined)
          : undefined,
      code_inline: ({ content }) => (
        <MarkdownInlineCode
          content={content ?? ""}
          textColor={inlineTextColor}
          codeColor={inlineCodeTextColor}
          fontSize={markdownFontSizes.codeBlockFontSize}
          lineHeight={markdownFontSizes.bodyLineHeight}
          onLinkPress={onLinkPress}
        />
      ),
      ...(preserveSoftBreaks
        ? {
            soft_break: () => <NativeText>{"\n"}</NativeText>,
          }
        : {}),
      code_block: ({ content = "", language }) => (
        <MarkdownCodeBlock
          backgroundColor={blockBackgroundColor}
          borderColor={markdownHrColor}
          content={content}
          copyTintColor={copyTintColor}
          fontSize={markdownFontSizes.codeBlockFontSize}
          headerTextColor={blockTextColor}
          highlightCode={highlightCode}
          language={language}
          lineHeight={markdownFontSizes.codeBlockLineHeight}
          textColor={blockTextColor}
          theme={themeMode}
        />
      ),
    });

    const userTheme: PartialMarkdownTheme = {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        text: markdownUserBodyColor,
        heading: markdownUserBodyColor,
        link: markdownUserBodyColor,
        code: markdownUserCodeText,
        codeBackground: markdownUserCodeBg,
        border: markdownUserFenceBg,
      },
    };
    const userStyles: NodeStyleOverrides = {
      ...baseStyles,
      paragraph: { marginTop: 0, marginBottom: 0 },
      bold: {
        fontWeight: "700",
        color: markdownUserBodyColor,
        fontFamily: boldFontFamily,
      },
      heading: {
        ...baseStyles.heading,
        color: markdownUserBodyColor,
        marginTop: 8,
        marginBottom: 4,
      },
      link: {
        color: markdownUserBodyColor,
        textDecorationLine: "underline" as const,
      },
    };

    const assistantTheme: PartialMarkdownTheme = {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        code: markdownCodeText,
        codeBackground: markdownCodeBg,
        border: markdownCodeBg,
      },
    };
    const assistantStyles: NodeStyleOverrides = {
      ...baseStyles,
    };

    return {
      user: {
        theme: userTheme,
        styles: userStyles,
        renderers: createMarkdownRenderers(
          markdownUserCodeText,
          markdownUserInlineCodeText,
          markdownUserFenceBg,
          markdownUserFenceText,
          userBubbleForegroundMuted,
          true,
          false,
        ),
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
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
        },
      },
      assistant: {
        theme: assistantTheme,
        styles: assistantStyles,
        renderers: createMarkdownRenderers(
          markdownCodeText,
          markdownInlineCodeText,
          markdownCodeBg,
          markdownCodeText,
          iconSubtleColor,
          false,
          true,
        ),
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
    iconSubtleColor,
    inlineSkillForeground,
    markdownBlockquoteBg,
    markdownBlockquoteBorder,
    markdownBodyColor,
    markdownCodeBg,
    markdownCodeText,
    markdownFontSizes,
    markdownHrColor,
    markdownInlineCodeText,
    markdownLinkColor,
    markdownStrongColor,
    markdownUserBodyColor,
    markdownUserCodeBg,
    markdownUserCodeText,
    markdownUserFenceBg,
    markdownUserFenceText,
    markdownUserInlineCodeText,
    nativeMarkdownTypography,
    onLinkPress,
    regularFontFamily,
    renderImage,
    themeMode,
    userBubbleForegroundMuted,
    userBubbleSkillForeground,
  ]);
}

function renderFeedEntry(
  info: { item: ThreadFeedEntry; index: number },
  props: Pick<ThreadFeedProps, "environmentId" | "onUseArtifactTemplate" | "skills"> & {
    readonly copiedRowId: string | null;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly workRowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
    readonly workGroupScrollPositions: Map<string, ThreadWorkGroupScrollPosition>;
    readonly terminalAssistantMessageIds: ReadonlySet<string>;
    readonly unsettledTurnId: TurnId | null;
    readonly onCopyWorkRow: (rowId: string, value: string) => void;
    readonly onToggleWorkGroup: (groupId: string, anchorKey: string) => void;
    readonly onToggleWorkRow: (rowId: string, anchorKey: string) => void;
    readonly onToggleTurnFold: (turnId: TurnId) => void;
    readonly onPressPreview: (source: FilePreviewSource) => void;
    readonly onPressVideo: (attachment: ChatFileAttachment, sourceIdentifier: string) => void;
    readonly markdownLinkHandlers: MarkdownLinkHandlers;
    readonly renderMarkdownImage: MarkdownImageRenderer;
    readonly renderViewedImage: MarkdownImageRenderer;
    readonly iconSubtleColor: string | import("react-native").ColorValue;
    readonly userBubbleColor: string | import("react-native").ColorValue;
    readonly markdownStyles: MarkdownStyleSets;
    readonly reviewCommentColors: ReviewCommentColors;
    readonly reviewCommentBubbleWidth: number;
    readonly themeAppearance: "light" | "dark";
    readonly userBubbleMaxWidth: number;
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
        className="mb-1 min-h-11 flex-row items-center gap-2 border-b border-adaptive-neutral-200-a80-white-a8 px-2"
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
        <View className="h-px flex-1 bg-adaptive-neutral-200-a80-white-a8" />
        <View className="shrink-0 flex-row items-center gap-1.5">
          <SymbolView
            name="arrow.down.right.and.arrow.up.left"
            size={12}
            tintColor={iconSubtleColor}
            type="monochrome"
          />
          <Text className="font-t3-medium text-xs text-foreground-muted">{label}</Text>
        </View>
        <View className="h-px flex-1 bg-adaptive-neutral-200-a80-white-a8" />
      </View>
    );
  }

  if (entry.type === "message") {
    const { message } = entry;
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
      const enterAnimated = isFreshTimestamp(message.createdAt);
      return (
        <Animated.View
          className="mb-5 items-end"
          {...(enterAnimated ? { entering: FadeInUp.duration(220) } : {})}
        >
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
            {message.text.trim().length > 0 ? (
              <UserMessageContent
                text={renderedText}
                markdownStyles={styles}
                reviewCommentColors={props.reviewCommentColors}
                skills={props.skills}
                linkHandlers={props.markdownLinkHandlers}
                renderImage={props.renderMarkdownImage}
              />
            ) : null}
            {attachments.map((attachment) => {
              return isImageAttachment(attachment) ? (
                <MessageAttachmentImage
                  key={attachment.id}
                  environmentId={props.environmentId}
                  attachmentId={attachment.id}
                  name={attachment.name}
                  mimeType={attachment.mimeType}
                  className="aspect-[1.3] w-full rounded-[14px] bg-white/15"
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
          <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
            <Text className="font-t3-medium text-xs tabular-nums text-adaptive-neutral-600-400">
              {timestampLabel}
            </Text>
            {message.text.trim().length > 0 ? (
              <CopyTextButton
                accessibilityLabel="Copy message"
                text={message.text}
                tintColor={iconSubtleColor}
                buttonSize={28}
                iconSize={13}
              />
            ) : null}
          </View>
        </Animated.View>
      );
    }

    // Skip empty assistant messages (no text, no attachments) — they would
    // render as an orphaned timestamp and break adjacent activity-group merging.
    if (renderedText.trim().length === 0 && attachments.length === 0) {
      return null;
    }

    const enterAnimated = isFreshTimestamp(message.createdAt);
    return (
      <Animated.View
        className={cn(showAssistantMeta ? "mb-5 px-1" : "mb-1 px-1")}
        {...(enterAnimated ? { entering: FadeIn.duration(220) } : {})}
      >
        {renderedText.trim().length > 0 ? (
          <AssistantMarkdownContent
            markdown={renderedText}
            markdownStyles={styles}
            linkHandlers={props.markdownLinkHandlers}
            onUseArtifactTemplate={props.onUseArtifactTemplate}
            renderImage={props.renderMarkdownImage}
            skills={props.skills}
          />
        ) : null}
        {attachments.map((attachment) => {
          return isImageAttachment(attachment) ? (
            <MessageAttachmentImage
              key={attachment.id}
              environmentId={props.environmentId}
              attachmentId={attachment.id}
              name={attachment.name}
              mimeType={attachment.mimeType}
              className="mt-1.5 aspect-[1.3] w-full rounded-[18px] bg-adaptive-neutral-200-800"
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
            <Text className="font-t3-medium text-xs tabular-nums text-adaptive-neutral-600-400">
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
      themeAppearance={props.themeAppearance}
      onCopyRow={props.onCopyWorkRow}
      onToggleRow={props.onToggleWorkRow}
      renderImage={props.renderViewedImage}
    />
  );
}

function UserMessageContent(props: {
  readonly text: string;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly renderImage: MarkdownImageRenderer;
}) {
  const segments = parseReviewCommentMessageSegments(props.text);
  const hasReviewComment = segments.some((segment) => segment.kind === "review-comment");
  if (!hasReviewComment) {
    if (hasNativeSelectableMarkdownText()) {
      return (
        <SelectableMarkdownText
          markdown={props.text}
          skills={props.skills}
          textStyle={props.markdownStyles.nativeTextStyle}
          preserveSoftBreaks
          {...props.linkHandlers}
          renderImage={props.renderImage}
        />
      );
    }
    return (
      <Markdown
        options={{ gfm: true }}
        renderers={props.markdownStyles.renderers}
        styles={props.markdownStyles.styles}
        theme={props.markdownStyles.theme}
      >
        {props.text}
      </Markdown>
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

        return hasNativeSelectableMarkdownText() ? (
          <SelectableMarkdownText
            key={segment.id}
            markdown={text}
            skills={props.skills}
            textStyle={props.markdownStyles.nativeTextStyle}
            preserveSoftBreaks
            {...props.linkHandlers}
            renderImage={props.renderImage}
          />
        ) : (
          <Markdown
            key={segment.id}
            options={{ gfm: true }}
            renderers={props.markdownStyles.renderers}
            styles={props.markdownStyles.styles}
            theme={props.markdownStyles.theme}
          >
            {text}
          </Markdown>
        );
      })}
    </View>
  );
}

const ReviewCommentCard = memo(function ReviewCommentCard(props: {
  readonly comment: ReviewInlineComment;
  readonly colors: ReviewCommentColors;
}) {
  const { codeSurface, nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance: appearanceScheme, themeId } = useAppearancePreferences();
  const appTheme = useUniwindTheme();
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const patch = useMemo(() => buildReviewCommentPatch(props.comment), [props.comment]);
  const parsedDiff = useMemo(
    () => buildReviewParsedDiff(patch, `thread-review-comment:${props.comment.id}`),
    [patch, props.comment.id],
  );
  const nativeReviewDiffData = useMemo(() => buildNativeReviewDiffData(parsedDiff), [parsedDiff]);
  const compactNativeRows = useMemo(
    () => nativeReviewDiffData.rows.filter((row) => row.kind !== "file"),
    [nativeReviewDiffData.rows],
  );
  const nativeReviewDiffTheme = useMemo(
    () => createNativeReviewDiffTheme(appearanceScheme, themeId, appTheme),
    [appearanceScheme, appTheme, themeId],
  );
  const nativeRowsJson = useMemo(() => JSON.stringify(compactNativeRows), [compactNativeRows]);
  const nativeThemeJson = useMemo(
    () => JSON.stringify(nativeReviewDiffTheme),
    [nativeReviewDiffTheme],
  );
  const nativeStyleJson = useMemo(
    () => JSON.stringify(nativeReviewDiffStyle),
    [nativeReviewDiffStyle],
  );
  const nativeDiffHeight = useMemo(
    () =>
      Math.min(
        360,
        Math.max(
          112,
          compactNativeRows.length * nativeReviewDiffStyle.rowHeight +
            nativeReviewDiffStyle.fileHeaderVerticalMargin,
        ),
      ),
    [compactNativeRows.length, nativeReviewDiffStyle],
  );
  const shouldRenderNativeDiff = NativeReviewDiffView != null && compactNativeRows.length > 0;

  return (
    <View
      className="w-full overflow-hidden rounded-[16px] border border-continuous"
      style={{
        backgroundColor: props.colors.background,
        borderColor: props.colors.border,
      }}
    >
      <View
        className="flex-row items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: props.colors.border }}
      >
        <View
          className="size-6 items-center justify-center rounded-[7px] border-continuous"
          style={{ backgroundColor: props.colors.mutedBackground }}
        >
          <SymbolView
            name="doc.text"
            size={13}
            tintColor={props.colors.mutedText}
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1">
          <Text
            className="font-mono text-xs"
            numberOfLines={1}
            style={{ color: props.colors.text }}
          >
            {compactFileName(props.comment.filePath)}
          </Text>
        </View>
      </View>
      {shouldRenderNativeDiff ? (
        <View
          className="border-t"
          collapsable={false}
          style={{
            backgroundColor: nativeReviewDiffTheme.background,
            borderColor: props.colors.border,
            height: nativeDiffHeight,
          }}
        >
          <NativeReviewDiffView
            collapsable={false}
            style={StyleSheet.absoluteFill}
            appearanceScheme={appearanceScheme}
            contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
            rowHeight={nativeReviewDiffStyle.rowHeight}
            rowsJson={nativeRowsJson}
            styleJson={nativeStyleJson}
            themeJson={nativeThemeJson}
          />
        </View>
      ) : props.comment.diff.trim().length > 0 ? (
        <ScrollView
          horizontal
          nestedScrollEnabled
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          bounces={false}
          className="border-t"
          style={{ backgroundColor: props.colors.codeBackground, borderColor: props.colors.border }}
          contentContainerStyle={{ padding: 10 }}
        >
          <NativeText
            selectable
            className="font-mono"
            style={{
              color: props.colors.text,
              fontSize: codeSurface.fontSize,
              lineHeight: codeSurface.rowHeight,
            }}
          >
            {props.comment.diff.trim()}
          </NativeText>
        </ScrollView>
      ) : null}
      {props.comment.text.length > 0 ? (
        <View className="border-t px-3 py-3" style={{ borderColor: props.colors.border }}>
          <Text selectable className="text-base leading-snug" style={{ color: props.colors.text }}>
            {props.comment.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

function buildReviewCommentPatch(comment: ReviewInlineComment): string {
  if ((comment.fenceLanguage ?? "diff") !== "diff") {
    return "";
  }
  const diff = comment.diff.trim();
  if (!diff) {
    return "";
  }

  if (diff.startsWith("diff --git ")) {
    return diff;
  }

  const normalizedPath = comment.filePath.replaceAll("\\", "/");
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    diff,
  ].join("\n");
}

function compactFileName(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const lastSlashIndex = normalized.lastIndexOf("/");
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
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
  }>({
    copiedRowId: null,
    expandedWorkGroups: {},
    expandedWorkRows: {},
    expandedTurnIds: new Set(),
  });
  const { copiedRowId, expandedWorkGroups, expandedWorkRows, expandedTurnIds } = interactionState;
  const [expandedFile, setExpandedFile] = useState<FilePreviewSource | null>(null);
  const [expandedVideo, setExpandedVideo] = useState<VideoPreviewSource | null>(null);
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
  const markdownLinkHandlers = useMemo<MarkdownLinkHandlers>(
    () => ({
      onLinkPress: onMarkdownLinkPress,
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
        }
      },
    }),
    [onMarkdownLinkPress, props.workspaceRoot],
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
  const markdownStyles = useMarkdownStyles(onMarkdownLinkPress, renderMarkdownImage);
  const reviewCommentColors = useReviewCommentColors();
  // LegendList does not invalidate visible rows when only the renderItem closure changes.
  // Keep row-local interaction props in extraData so disclosures and copy feedback repaint.
  const listAppearanceData = useMemo(
    () => ({
      copiedRowId,
      expandedWorkRows,
      workRowSizing,
      iconSubtleColor,
      markdownStyles,
      reviewCommentColors,
      themeAppearance,
      userBubbleColor,
      viewportWidth,
    }),
    [
      copiedRowId,
      expandedWorkRows,
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
      deriveThreadFeedPresentation(
        props.feed,
        props.latestTurn,
        expandedTurnIds,
        expandedWorkGroupIds,
        props.activeWorkStartedAt,
      ),
    [
      expandedTurnIds,
      expandedWorkGroupIds,
      props.activeWorkStartedAt,
      props.feed,
      props.latestTurn,
    ],
  );
  // The empty↔filled key below remounts the list and resets its imperative
  // content-inset override. Seed the fresh instance synchronously with the
  // current overlay height before the scroll integration's next reaction;
  // on Android the declarative contentInset floor covers this same window.
  const listMountKey = `${feedThreadKey}:${props.feed.length === 0 ? "empty" : "filled"}`;
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
  const unsettledTurnId =
    props.latestTurn &&
    (props.latestTurn.completedAt === null || props.latestTurn.state === "running")
      ? props.latestTurn.turnId
      : null;

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
  }, [expandedTurnIds, expandedWorkGroups, expandedWorkRows, settleDisclosureAfterLayout]);

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
        case "turn-fold":
          return TURN_FOLD_HEIGHT;
        case "work-toggle":
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
    [expandedWorkRows, workRowSizing.fixedRowHeight],
  );

  // Disclosures can mount existing offscreen rows as well as new work rows.
  // Fade those in after movement; never retain removed rows over replacements.
  const renderItem = useCallback(
    (info: { item: ThreadFeedEntry; index: number }) => (
      <Animated.View
        key={info.item.id}
        entering={disclosureToggleSettling ? THREAD_FEED_DISCLOSURE_ENTER_TRANSITION : undefined}
      >
        <ThreadMediaVisibility>
          {renderFeedEntry(info, {
            environmentId: props.environmentId,
            copiedRowId,
            expandedWorkRows,
            workRowSizing,
            workGroupScrollPositions,
            terminalAssistantMessageIds,
            unsettledTurnId,
            onCopyWorkRow,
            onToggleWorkGroup,
            onToggleWorkRow,
            onToggleTurnFold,
            onPressPreview,
            onPressVideo,
            markdownLinkHandlers,
            renderMarkdownImage,
            renderViewedImage,
            iconSubtleColor,
            userBubbleColor,
            markdownStyles,
            reviewCommentColors,
            reviewCommentBubbleWidth,
            themeAppearance,
            userBubbleMaxWidth,
            skills: props.skills,
            onUseArtifactTemplate: props.onUseArtifactTemplate,
          })}
        </ThreadMediaVisibility>
      </Animated.View>
    ),
    [
      copiedRowId,
      disclosureToggleSettling,
      expandedWorkRows,
      workRowSizing,
      workGroupScrollPositions,
      terminalAssistantMessageIds,
      unsettledTurnId,
      iconSubtleColor,
      userBubbleColor,
      markdownStyles,
      reviewCommentColors,
      reviewCommentBubbleWidth,
      themeAppearance,
      userBubbleMaxWidth,
      onCopyWorkRow,
      markdownLinkHandlers,
      onPressPreview,
      onPressVideo,
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

  if (props.contentPresentation.kind === "unavailable") {
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
    <>
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
            // Animated: on send, the optimistic message's dataChange fires
            // maintainScrollAtEnd before any render-cycle suppression could
            // engage — an instant snap there teleports the feed to the anchor
            // instead of scrolling to it. Keeping it enabled (animated) during
            // anchor scrolls also lets it correct a scroll that landed on a
            // stale end target once the anchor row finishes measuring.
            maintainScrollAtEnd={
              disclosureToggleSettling || !endFollowEnabled
                ? false
                : {
                    animated: true,
                    on: {
                      dataChange: true,
                      itemLayout: true,
                      layout: true,
                    },
                  }
            }
            maintainVisibleContentPosition={maintainVisibleContentPosition}
            data={presentedFeed}
            extraData={listAppearanceData}
            renderItem={renderItem}
            viewabilityConfig={THREAD_MEDIA_VIEWABILITY_CONFIG}
            keyExtractor={(entry) => entry.id}
            getItemType={(entry) =>
              entry.type === "message" ? `message:${entry.message.role}` : entry.type
            }
            getFixedItemSize={getFixedItemSize}
            itemLayoutAnimation={THREAD_FEED_LAYOUT_TRANSITION}
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
        {props.feed.length === 0 &&
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
      </View>

      <VideoPreviewModal source={expandedVideo} onRequestClose={() => setExpandedVideo(null)} />
      <FilePreviewModal source={expandedFile} onRequestClose={() => setExpandedFile(null)} />
    </>
  );
});
