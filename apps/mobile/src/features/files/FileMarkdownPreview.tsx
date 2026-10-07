import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { resolveMobileMarkdownMediaSource } from "../../lib/markdownMediaSource";
import { getBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useFontFamily } from "../../lib/useFontFamily";
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

function useMarkdownPreviewStyles(): MarkdownPreviewStyles {
  const { appearance } = useAppearancePreferences();
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const theme = useUniwindTheme();
  const body = theme["--color-md-body"];
  const strong = theme["--color-md-strong"];
  const link = theme["--color-md-link"];
  const blockquoteBorder = theme["--color-md-blockquote-border"];
  const codeBackground = theme["--color-md-code-bg"];
  const codeText = theme["--color-md-code-text"];
  const horizontalRule = theme["--color-md-hr"];
  const regularFontFamily = useFontFamily("regular");
  const boldFontFamily = useFontFamily("bold");

  return useMemo(() => {
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
  }, [
    blockquoteBorder,
    body,
    codeBackground,
    codeText,
    horizontalRule,
    link,
    nativeMarkdownTypography,
    regularFontFamily,
    strong,
    boldFontFamily,
  ]);
}

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly captured?: boolean;
  readonly environmentId: EnvironmentId;
  readonly markdown: string;
  readonly relativePath: string;
  /** Absent for a file opened from a project draft, which has no thread yet. */
  readonly threadId: ThreadId | null;
  readonly onRefresh?: () => Promise<void> | void;
}) {
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [expandedFile, setExpandedFile] = useState<FilePreviewSource | null>(null);
  const handlePullToRefresh = useCallback(async () => {
    if (!props.onRefresh) {
      return;
    }
    setIsPullRefreshing(true);
    try {
      await props.onRefresh();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [props.onRefresh]);
  const markdownDirectory = useMemo(
    () => getBrowseDirectoryPath(resolveWorkspaceFilePath(props.cwd, props.relativePath)),
    [props.cwd, props.relativePath],
  );
  const renderImage = useCallback<MarkdownImageRenderer>(
    (image) => {
      const media = resolveMobileMarkdownMediaSource(image.href, {
        threadId: props.threadId ?? undefined,
        workspaceRoot: markdownDirectory,
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
            onPressPreview={setExpandedFile}
          />
        );
      }
      if (props.captured || media === null || media.access === "unavailable") {
        return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      }
      if (media.kind === "video") {
        if (!props.threadId) {
          return (
            <ThreadMarkdownVideo
              source={{
                type: "media",
                name: media.name,
                mimeType: media.mimeType,
                environmentId: props.environmentId,
                resource: media.resource,
                srcFragment: media.srcFragment,
              }}
              thumbnailVisible
            />
          );
        }
        const preview = resolveMarkdownMediaPreview(image.href, {
          environmentId: props.environmentId,
          threadId: props.threadId,
          workspaceRoot: markdownDirectory,
        });
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
          onPressPreview={setExpandedFile}
        />
      );
    },
    [markdownDirectory, props.environmentId, props.threadId, props.captured],
  );
  const styles = useMarkdownPreviewStyles();
  const resolveImageSource = useMarkdownImageSource({
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: markdownDirectory,
    captured: props.captured,
  });
  const onImagePress = useCallback(
    (href: string) => {
      const direct = resolveMobileMarkdownMediaSource(href, {
        threadId: props.threadId ?? undefined,
        workspaceRoot: markdownDirectory,
        imageEmbed: true,
      });
      if (direct?.access === "direct" && direct.kind === "image") {
        setExpandedFile({
          kind: "image",
          uri: normalizeNativeMarkdownUrl(direct.uri),
          name: direct.name,
        });
        return;
      }
      if (props.captured) return;
      if (!props.threadId) {
        if (direct?.access === "environment" && direct.kind === "image") {
          setExpandedFile({
            kind: "image",
            name: direct.name,
            environmentId: props.environmentId,
            resource: direct.resource,
            srcFragment: direct.srcFragment,
          });
        }
        return;
      }
      const media = resolveMarkdownMediaPreview(href, {
        environmentId: props.environmentId,
        threadId: props.threadId,
        workspaceRoot: markdownDirectory,
      });
      if (media?.kind === "image") setExpandedFile(media.source);
    },
    [markdownDirectory, props.environmentId, props.threadId, props.captured],
  );
  const onLinkPress = useCallback((href: string) => {
    void tryOpenExternalUrl(href, "markdown-link");
  }, []);

  return (
    <ScrollView
      className="flex-1 bg-sheet"
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
      </View>
    </ScrollView>
  );
}
