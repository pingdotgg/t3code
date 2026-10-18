import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { resolveMobileMarkdownMediaSource } from "../../lib/markdownMediaSource";
import { getBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import { useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { FONT_FAMILIES } from "../../lib/fontFamilies";
import { resolveNativeMarkdownTypography } from "../../lib/appearancePreferences";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageView,
  ThreadMarkdownImageUnavailable,
} from "../threads/ThreadMarkdownImage";
import { ThreadMarkdownVideo } from "../threads/ThreadMarkdownVideo";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { normalizeNativeMarkdownUrl } from "../../lib/markdownLinks";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { useMarkdownImageSource } from "../../native/useMarkdownImageSource";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
  type NativeMarkdownTextStyle,
} from "../../native/SelectableMarkdownText";
import { resolveWorkspaceFilePath } from "./filePath";

interface MarkdownPreviewStyles {
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

export function useMarkdownPreviewStyles(): MarkdownPreviewStyles {
  const { appearance } = useAppearancePreferences();
  const nativeMarkdownTypography = resolveNativeMarkdownTypography(appearance.baseFontSize);
  const theme = useUniwindTheme();
  const body = theme["--color-md-body"];
  const strong = theme["--color-md-strong"];
  const link = theme["--color-md-link"];
  const blockquoteBorder = theme["--color-md-blockquote-border"];
  const codeBackground = theme["--color-md-code-bg"];
  const codeText = theme["--color-md-code-text"];
  const horizontalRule = theme["--color-md-hr"];
  const regularFontFamily = FONT_FAMILIES.regular;
  const boldFontFamily = FONT_FAMILIES.bold;

  return {
    nativeTextStyle: {
      color: body,
      strongColor: strong,
      mutedColor: body,
      linkColor: link,
      inlineCodeColor: codeText,
      codeColor: codeText,
      codeBackgroundColor: codeBackground,
      codeBlockBackgroundColor: codeBackground,
      fileTextColor: codeText,
      skillTextColor: codeText,
      quoteMarkerColor: blockquoteBorder,
      dividerColor: horizontalRule,
      fontSize: nativeMarkdownTypography.fontSize,
      lineHeight: nativeMarkdownTypography.lineHeight,
      headingFontSizes: nativeMarkdownTypography.headingFontSizes,
      fontFamily: regularFontFamily,
      headingFontFamily: boldFontFamily,
      boldFontFamily,
    },
  };
}

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly captured?: boolean;
  readonly environmentId: EnvironmentId;
  readonly markdown: string;
  readonly relativePath: string;
  readonly threadId: ThreadId | null;
  readonly onRefresh?: () => Promise<void> | void;
}) {
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [expandedFile, setExpandedFile] = useState<FilePreviewSource | null>(null);
  const [expandedVideo, setExpandedVideo] = useState<VideoPreviewSource | null>(null);
  const handlePullToRefresh = async () => {
    if (!props.onRefresh) {
      return;
    }
    setIsPullRefreshing(true);
    // RefreshControl only needs the spinner cleared; the caller surfaces its own errors.
    await settlePromise(async () => props.onRefresh?.());
    setIsPullRefreshing(false);
  };
  const markdownDirectory = getBrowseDirectoryPath(
    resolveWorkspaceFilePath(props.cwd, props.relativePath),
  );
  const renderImage: MarkdownImageRenderer = (image) => {
    const media = resolveMobileMarkdownMediaSource(image.href, {
      threadId: props.threadId ?? undefined,
      workspaceRoot: markdownDirectory,
      imageEmbed: true,
    });
    const preview = resolveMarkdownMediaPreview(image.href, {
      environmentId: props.environmentId,
      threadId: props.threadId ?? undefined,
      workspaceRoot: markdownDirectory,
      captured: props.captured,
      imageEmbed: true,
    });
    if (media?.access === "direct") {
      if (media.kind === "video") {
        return (
          <ThreadMarkdownVideo
            source={{
              type: "media",
              name: media.name,
              mimeType: media.mimeType,
              uri: normalizeNativeMarkdownUrl(media.uri),
              actionsSource: preview?.source.actionsSource,
            }}
            thumbnailVisible
          />
        );
      }
      return (
        <ThreadMarkdownImageView
          uri={normalizeNativeMarkdownUrl(media.uri)}
          sourceKey={media.uri}
          unavailable={false}
          alt={image.alt}
          format={media.mimeType === "image/svg+xml" ? "svg" : undefined}
          actionsSource={preview?.source.actionsSource}
          onPressPreview={setExpandedFile}
        />
      );
    }
    if (props.captured || media === null || media.access === "unavailable") {
      return <ThreadMarkdownImageUnavailable alt={image.alt} />;
    }
    if (media.kind === "video") {
      return preview?.kind === "video" ? (
        <ThreadMarkdownVideo source={preview.source} thumbnailVisible />
      ) : (
        <ThreadMarkdownImageUnavailable alt={image.alt} />
      );
    }
    return (
      <ThreadMarkdownImage
        environmentId={props.environmentId}
        resource={media.resource}
        alt={image.alt}
        srcFragment={media.srcFragment}
        actionsSource={preview?.source.actionsSource}
        onPressPreview={setExpandedFile}
      />
    );
  };
  const styles = useMarkdownPreviewStyles();
  const resolveImageSource = useMarkdownImageSource({
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: markdownDirectory,
    captured: props.captured,
  });
  const openMedia = (href: string, imageEmbed = false) => {
    const media = resolveMarkdownMediaPreview(href, {
      environmentId: props.environmentId,
      threadId: props.threadId ?? undefined,
      workspaceRoot: markdownDirectory,
      captured: props.captured,
      imageEmbed,
    });
    if (!media) return false;
    if (media.kind === "video") setExpandedVideo(media.source);
    else setExpandedFile(media.source);
    return true;
  };
  const onImagePress = (href: string) => {
    openMedia(href, true);
  };
  const onLinkPress = (href: string) => {
    if (!openMedia(href)) void tryOpenExternalUrl(href, "markdown-link");
  };

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 18 }}
      refreshControl={
        props.onRefresh ? (
          <RefreshControl
            refreshing={isPullRefreshing}
            onRefresh={() => void handlePullToRefresh()}
          />
        ) : undefined
      }
    >
      <View className="mx-auto w-full max-w-[760px]">
        <SelectableMarkdownText
          markdown={props.markdown}
          onLinkPress={onLinkPress}
          renderImage={renderImage}
          resolveImageSource={resolveImageSource}
          onImagePress={onImagePress}
          textStyle={styles.nativeTextStyle}
        />
        <FilePreviewModal source={expandedFile} onRequestClose={() => setExpandedFile(null)} />
        <VideoPreviewModal source={expandedVideo} onRequestClose={() => setExpandedVideo(null)} />
      </View>
    </ScrollView>
  );
}
