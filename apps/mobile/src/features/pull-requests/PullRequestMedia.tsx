import { useGT } from "gt-react-native";
import { createContext, useContext, useId, useState } from "react";
import {
  pullRequestMediaSource,
  pullRequestImageSource,
  pullRequestScopedSourceIdentifier,
  pullRequestVideoMimeType,
  type PullRequestMediaLocation,
} from "./pullRequestMediaSource";
import { useFilePreviewGallery } from "../../components/ui/FilePreviewGallery";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { AppText } from "../../components/ui/AppText";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { assetImageCacheKey } from "../../lib/assetImageSource";
import { filePreviewSourceIdentifier, imagePreviewName } from "../../lib/filePreviewGallery";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { VideoAttachmentTile } from "../../components/VideoAttachmentTile";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/ui/VideoPreviewModal";
import { PresentationSource } from "../../components/ui/NativePresentation";
import { ThreadMarkdownImageView } from "../threads/ThreadMarkdownImage";
import {
  FilePreviewModal,
  type FilePreviewSource,
  type FilePreviewItem,
} from "../../components/ui/FilePreviewModal";

export const PullRequestMediaVisibleContext = createContext(true);

export const PullRequestMediaContext = createContext<PullRequestMediaLocation | null>(null);

export const PullRequestGalleryScopeContext = createContext<string | null>(null);

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

export function PullRequestMedia(props: {
  readonly url: string;
  readonly kind: "image" | "video" | "unknown";
  readonly caption?: string;
  readonly compact?: boolean;
}) {
  const media = usePullRequestMediaUrl(props.url);
  const gt = useGT();
  const visible = useContext(PullRequestMediaVisibleContext);
  const context = useContext(PullRequestMediaContext);
  const galleryScope = useContext(PullRequestGalleryScopeContext);
  const withGallery = useFilePreviewGallery();
  const [image, setImage] = useState<FilePreviewSource | null>(null);
  const [video, setVideo] = useState<VideoPreviewSource | null>(null);
  const name = props.caption || props.url.split(/[?#]/)[0]?.split("/").pop() || gt("Attachment");
  if (props.kind === "image") {
    const imageName = imagePreviewName(props.url, props.caption, gt("Image"));
    const previewSource = pullRequestImageSource(props.url, context, imageName);
    const sourceIdentifier = galleryScope
      ? pullRequestScopedSourceIdentifier(galleryScope, previewSource)
      : filePreviewSourceIdentifier(previewSource);
    return (
      <>
        <ThreadMarkdownImageView
          uri={media.uri}
          sourceKey={props.url}
          sourceIdentifier={sourceIdentifier}
          cacheKey={media.cacheKey}
          unavailable={media.unavailable}
          alt={props.caption ?? null}
          actionsSource={previewSource.actionsSource}
          onPressPreview={(source) =>
            setImage(
              withGallery({
                ...previewSource,
                sourceIdentifier: source.sourceIdentifier,
              }),
            )
          }
        />
        <FilePreviewModal source={image} onRequestClose={() => setImage(null)} />
      </>
    );
  }
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
              mimeType: pullRequestVideoMimeType(props.url) ?? "video/mp4",
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
  const gt = useGT();
  const localSourceIdentifier = useId();
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const imageKey = media.uri ? (media.cacheKey ?? media.uri) : null;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loaded = imageKey !== null && loadedKey === imageKey;
  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={gt("View attachment: {caption}", { caption: props.caption })}
        onPress={() =>
          setPreview({
            ...props.source,
            sourceIdentifier: localSourceIdentifier,
            gallery: props.gallery,
          })
        }
        className="gap-2 active:opacity-70"
        style={{ width: 176 }}
      >
        <PresentationSource
          identifier={loaded ? localSourceIdentifier : ""}
          fallbackIdentifier={loaded ? filePreviewSourceIdentifier(props.source) : ""}
        >
          <View className="overflow-hidden rounded-2xl border border-border-subtle bg-grouped-card">
            <Image
              source={media.uri ? { uri: media.uri, cacheKey: media.cacheKey } : null}
              style={{ width: 174, height: 112 }}
              contentFit="contain"
              cachePolicy="memory-disk"
              onLoad={() => setLoadedKey(imageKey)}
              onError={() => setLoadedKey(null)}
            />
          </View>
        </PresentationSource>
        <AppText numberOfLines={1} className="text-xs text-foreground-muted">
          {props.caption}
        </AppText>
      </Pressable>
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </>
  );
}
