import { createContext, useContext, useState } from "react";
import {
  pullRequestMediaSource,
  pullRequestImageSource,
  type PullRequestMediaLocation,
} from "./pullRequestMediaSource";
import { useFilePreviewGallery } from "../../components/ui/FilePreviewGallery";
import { videoMimeType } from "@t3tools/shared/video";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { AppText } from "../../components/ui/AppText";
import { pullRequestMediaResource } from "@t3tools/client-runtime/pull-request-markdown";
import { refreshAssetUrl, useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import type { MarkdownImageSourceResolver } from "../../native/SelectableMarkdownText.types";
import { assetImageCacheKey } from "../../lib/assetImageSource";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { VideoAttachmentTile } from "../../components/VideoAttachmentTile";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/ui/VideoPreviewModal";
import { ThreadMarkdownImageView } from "../threads/ThreadMarkdownImage";
import {
  FilePreviewModal,
  type FilePreviewSource,
  type FilePreviewItem,
} from "../../components/ui/FilePreviewModal";

export const PullRequestMediaVisibleContext = createContext(true);

export const PullRequestMediaContext = createContext<PullRequestMediaLocation | null>(null);

export function usePullRequestMediaUrl(url: string) {
  const context = useContext(PullRequestMediaContext);
  const source = pullRequestMediaSource(url, context);
  const resource = "resource" in source ? (source.resource ?? null) : null;
  const asset = useAssetUrlState(context?.environmentId ?? null, resource);
  const refresh = useRefreshAssetUrl(context?.environmentId ?? null, resource);
  return {
    uri: asset._tag === "Success" ? asset.url : resource ? null : url,
    cacheKey: context && resource ? assetImageCacheKey(context.environmentId, resource) : undefined,
    unavailable: resource !== null && asset._tag === "Failure",
    source,
    resolvePlaybackUri: resource ? async () => (await refresh()) ?? null : undefined,
  };
}

/** For images the native renderer draws itself, such as one wrapped in a link. */
export function usePullRequestImageSource(
  resolveUrl: (href: string) => string,
): MarkdownImageSourceResolver {
  const context = useContext(PullRequestMediaContext);
  return async (image) => {
    const url = resolveUrl(image.href);
    const resource = context && pullRequestMediaResource(url, context.cwd, context.repository);
    if (!resource) return { uri: url };
    const uri = await refreshAssetUrl(context.environmentId, resource);
    if (uri === null) throw new Error("Pull request image is unavailable");
    return { uri };
  };
}

export function PullRequestMedia(props: {
  readonly url: string;
  readonly kind: "image" | "video" | "unknown";
  readonly caption?: string;
  readonly compact?: boolean;
}) {
  const media = usePullRequestMediaUrl(props.url);
  const visible = useContext(PullRequestMediaVisibleContext);
  const context = useContext(PullRequestMediaContext);
  const withGallery = useFilePreviewGallery();
  const [image, setImage] = useState<FilePreviewSource | null>(null);
  const [video, setVideo] = useState<VideoPreviewSource | null>(null);
  const name = props.caption || new URL(props.url).pathname.split("/").pop() || "Attachment";
  if (props.kind === "image")
    return (
      <>
        <ThreadMarkdownImageView
          uri={media.uri}
          sourceKey={props.url}
          cacheKey={media.cacheKey}
          unavailable={media.unavailable}
          alt={name}
          onPressPreview={(source) =>
            setImage(
              withGallery({
                ...pullRequestImageSource(props.url, context),
                name,
                sourceIdentifier: source.sourceIdentifier,
              }),
            )
          }
        />
        <FilePreviewModal source={image} onRequestClose={() => setImage(null)} />
      </>
    );
  return (
    <View style={props.compact ? { width: 176 } : undefined}>
      {props.compact ? (
        <VideoAttachmentTile
          name={name}
          sourceIdentifier={props.url}
          thumbnailSource={visible ? media.uri : null}
          style={{ width: 176, height: 112, borderRadius: 16 }}
          onPress={() =>
            setVideo({
              type: "media",
              ...media.source,
              name,
              mimeType:
                videoMimeType({ name: props.url.split(/[?#]/)[0] ?? props.url, mimeType: "" }) ??
                "video/mp4",
            })
          }
        />
      ) : (
        <MediaVideoPlayer
          uri={media.uri}
          unavailable={media.unavailable}
          name={name}
          thumbnailKey={props.url}
          thumbnailVisible={visible}
          visible={visible}
          resolvePlaybackUri={media.resolvePlaybackUri}
        />
      )}
      <VideoPreviewModal source={video} onRequestClose={() => setVideo(null)} />
    </View>
  );
}

export function PullRequestImageAttachment(props: {
  readonly url: string;
  readonly caption: string;
  readonly source: FilePreviewItem;
  readonly gallery: readonly FilePreviewItem[];
}) {
  const media = usePullRequestMediaUrl(props.url);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`View attachment: ${props.caption}`}
        onPress={() => setPreview({ ...props.source, gallery: props.gallery })}
        className="gap-2 active:opacity-70"
        style={{ width: 176 }}
      >
        <View className="overflow-hidden rounded-2xl border border-border-subtle bg-grouped-card">
          <Image
            source={media.uri ? { uri: media.uri, cacheKey: media.cacheKey } : null}
            style={{ width: 174, height: 112 }}
            contentFit="contain"
            cachePolicy="memory-disk"
          />
        </View>
        <AppText numberOfLines={1} className="text-xs text-foreground-muted">
          {props.caption}
        </AppText>
      </Pressable>
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </>
  );
}
