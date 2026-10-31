import { AppText as Text } from "../../components/ui/AppText";
import { ThreadInlineFilePreview } from "./ThreadInlineFilePreview";
import type { NativeMarkdownTextStyle } from "../../native/SelectableMarkdownText";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import {
  normalizeNativeMarkdownUrl,
  resolveMarkdownLinkPresentation,
} from "../../lib/markdownLinks";
import type { MarkdownImageRenderer } from "../../native/SelectableMarkdownText";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";
import { ThreadMarkdownVideo } from "./ThreadMarkdownVideo";

export function useThreadMarkdownImageRenderer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
  readonly onLinkPress: (href: string, imageEmbed?: boolean) => void;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly setExpandedFile: Dispatch<SetStateAction<FilePreviewSource | null>>;
}): MarkdownImageRenderer {
  const { environmentId, threadId, workspaceRoot, setExpandedFile, onLinkPress, textStyle } = props;
  return useCallback<MarkdownImageRenderer>(
    (image) => {
      const media = resolveMarkdownMediaPreview(image.href, {
        environmentId: environmentId,
        threadId: threadId,
        workspaceRoot: workspaceRoot,
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
      if (media?.kind === "audio") {
        return (
          <ThreadInlineFilePreview
            key={image.href}
            source={media.source}
            onOpen={() => onLinkPress(image.href, true)}
          />
        );
      }
      const fileLink = resolveMarkdownLinkPresentation(image.href);
      if (
        (media && (media.kind === "pdf" || media.kind === "document" || media.kind === "file")) ||
        (fileLink.kind === "file" && fileLink.line !== undefined)
      ) {
        const name =
          media?.source.name ?? (fileLink.kind === "file" ? fileLink.label : "Open file");
        return (
          <Text
            accessibilityRole="link"
            accessibilityLabel={`Open ${name}`}
            onPress={() => onLinkPress(image.href, true)}
            style={{
              color: textStyle.linkColor,
              fontSize: textStyle.fontSize,
              lineHeight: textStyle.lineHeight,
            }}
          >
            {name}
          </Text>
        );
      }
      const imageSource = classifyMarkdownImageSource(image.href, workspaceRoot);
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
            onPressPreview={(source) => setExpandedFile((current) => current ?? source)}
          />
        );
      }
      if (imageSource._tag === "Blocked") {
        return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      }
      return (
        <ThreadMarkdownImage
          environmentId={environmentId}
          resource={{
            _tag: "media-file",
            threadId: threadId,
            path: imageSource.path,
          }}
          alt={image.alt}
          srcFragment={markdownImageSourceFragment(image.href)}
          actionsSource={media?.source.actionsSource}
          onPressPreview={(source) => setExpandedFile((current) => current ?? source)}
        />
      );
    },
    [environmentId, threadId, workspaceRoot, setExpandedFile, onLinkPress, textStyle],
  );
}
