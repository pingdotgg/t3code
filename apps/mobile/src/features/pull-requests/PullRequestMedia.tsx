import { createContext, useContext, useMemo, useState } from "react";
import { pullRequestMediaSource, pullRequestImageSource } from "./pullRequestMediaSource";
import { useFilePreviewGallery } from "../../components/FilePreviewGallery";
import type { EnvironmentId } from "@t3tools/contracts";
import { pullRequestMediaResource } from "@t3tools/shared/pullRequestMedia";
import { videoMimeType } from "@t3tools/shared/video";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { mediaPreviewUri } from "../../lib/mediaPreviewUri";
import { AppText } from "../../components/ui/AppText";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { VideoAttachmentTile } from "../../components/VideoAttachmentTile";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { ThreadMarkdownImageView } from "../threads/ThreadMarkdownImage";
import {
  FilePreviewModal,
  type FilePreviewSource,
  type FilePreviewItem,
} from "../../components/FilePreviewModal";

export const PullRequestMediaContext = createContext<{
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
} | null>(null);

export function usePullRequestMediaUrl(url: string) {
  const context = useContext(PullRequestMediaContext);
  const resource = useMemo(
    () => (context ? pullRequestMediaResource(url, context.cwd) : null),
    [context, url],
  );
  const asset = useAssetUrlState(context?.environmentId ?? null, resource);
  const source = pullRequestMediaSource(url, context);
  const fallbackUri = "fallbackUri" in source ? source.fallbackUri : undefined;
  const refresh = useRefreshAssetUrl(context?.environmentId ?? null, resource, fallbackUri);
  const srcFragment = "srcFragment" in source ? source.srcFragment : undefined;
  const uri = mediaPreviewUri(
    asset._tag === "Success"
      ? asset.url
      : resource
        ? asset._tag === "Failure"
          ? (fallbackUri ?? null)
          : null
        : url,
    srcFragment,
  );
  return {
    uri,
    unavailable: uri === null && resource !== null && asset._tag === "Failure",
    source,
    resolvePlaybackUri: resource
      ? async () => mediaPreviewUri(await refresh(), srcFragment)
      : undefined,
  };
}

export function PullRequestMedia(props: {
  readonly url: string;
  readonly kind: "image" | "video" | "unknown";
  readonly caption?: string;
  readonly compact?: boolean;
}) {
  const media = usePullRequestMediaUrl(props.url);
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
          thumbnailSource={media.uri}
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
            source={media.uri ? { uri: media.uri } : null}
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
