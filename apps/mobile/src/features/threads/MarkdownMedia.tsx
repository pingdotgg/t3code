import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  isWorkspaceVideoPreviewPath,
  markdownMediaFileName,
  resolveMarkdownMediaSource,
} from "@t3tools/shared/filePreview";
import { useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, type ColorValue, View } from "react-native";
import { WebView } from "react-native-webview";

import { useAssetUrlState } from "../../state/assets";

interface MarkdownMediaProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly src: string;
  readonly alt?: string;
  readonly title?: string;
  readonly backgroundColor: ColorValue;
  readonly mutedColor: ColorValue;
  readonly onPressImage: (uri: string) => void;
}

function normalizeDirectUrl(url: string): string {
  return url.startsWith("//") ? `https:${url}` : url;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function MediaUnavailable(props: { readonly name: string; readonly color: ColorValue }) {
  return (
    <View className="my-1 max-w-full self-start rounded-lg border border-border px-2.5 py-1.5">
      <Text className="font-mono text-xs" style={{ color: props.color }}>
        Media unavailable: {props.name}
      </Text>
    </View>
  );
}

function LoadingMedia(props: {
  readonly name: string;
  readonly backgroundColor: ColorValue;
  readonly color: ColorValue;
}) {
  return (
    <View
      className="my-2 h-40 w-full items-center justify-center gap-2 rounded-xl"
      style={{ backgroundColor: props.backgroundColor }}
    >
      <ActivityIndicator color={props.color} />
      <Text className="font-mono text-xs" numberOfLines={1} style={{ color: props.color }}>
        {props.name}
      </Text>
    </View>
  );
}

function MarkdownVideo(props: {
  readonly url: string;
  readonly name: string;
  readonly backgroundColor: ColorValue;
  readonly color: ColorValue;
  readonly onError: () => void;
}) {
  const html = useMemo(() => {
    const url = escapeHtmlAttribute(props.url);
    const name = escapeHtmlAttribute(props.name);
    return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <style>
      html, body { background: #000; height: 100%; margin: 0; overflow: hidden; width: 100%; }
      video { height: 100%; object-fit: contain; width: 100%; }
    </style>
  </head>
  <body>
    <video id="media" controls playsinline preload="metadata" aria-label="${name}" src="${url}"></video>
    <script>
      document.getElementById("media").addEventListener("error", function () {
        window.ReactNativeWebView.postMessage("media-error");
      }, { once: true });
    </script>
  </body>
</html>`;
  }, [props.name, props.url]);

  return (
    <View className="my-2 w-full gap-1.5">
      <View
        className="w-full overflow-hidden rounded-xl"
        style={{ aspectRatio: 16 / 9, backgroundColor: props.backgroundColor }}
      >
        <WebView
          accessibilityLabel={`Video ${props.name}`}
          allowsFullscreenVideo
          allowsInlineMediaPlayback
          bounces={false}
          javaScriptEnabled
          mediaPlaybackRequiresUserAction
          onError={props.onError}
          onMessage={(event) => {
            if (event.nativeEvent.data === "media-error") {
              props.onError();
            }
          }}
          originWhitelist={["*"]}
          scrollEnabled={false}
          source={{ html }}
          style={{ flex: 1, backgroundColor: "#000000" }}
        />
      </View>
      <Text className="font-sans text-xs" numberOfLines={1} style={{ color: props.color }}>
        {props.name}
      </Text>
    </View>
  );
}

function ResolvedMedia(props: {
  readonly url: string;
  readonly name: string;
  readonly isVideo: boolean;
  readonly backgroundColor: ColorValue;
  readonly color: ColorValue;
  readonly onPressImage: (uri: string) => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [measuredImage, setMeasuredImage] = useState<{
    readonly url: string;
    readonly aspectRatio: number;
  } | null>(null);
  const aspectRatio = measuredImage?.url === props.url ? measuredImage.aspectRatio : 16 / 9;

  if (failedUrl === props.url) {
    return <MediaUnavailable name={props.name} color={props.color} />;
  }

  if (props.isVideo) {
    return (
      <MarkdownVideo
        url={props.url}
        name={props.name}
        backgroundColor={props.backgroundColor}
        color={props.color}
        onError={() => setFailedUrl(props.url)}
      />
    );
  }

  return (
    <View className="my-2 w-full gap-1.5">
      <Pressable
        accessibilityLabel={`Expand image ${props.name}`}
        accessibilityRole="button"
        className="w-full overflow-hidden rounded-xl active:opacity-80"
        onPress={() => props.onPressImage(props.url)}
        style={{ aspectRatio, backgroundColor: props.backgroundColor }}
      >
        <Image
          accessibilityLabel={props.name}
          onError={() => setFailedUrl(props.url)}
          onLoad={(event) => {
            const { width, height } = event.nativeEvent.source;
            if (width > 0 && height > 0) {
              setMeasuredImage({
                url: props.url,
                aspectRatio: Math.min(2, Math.max(0.75, width / height)),
              });
            }
          }}
          resizeMode="contain"
          source={{ uri: props.url }}
          style={{ height: "100%", width: "100%" }}
        />
      </Pressable>
      <Text className="font-sans text-xs" numberOfLines={1} style={{ color: props.color }}>
        {props.name}
      </Text>
    </View>
  );
}

export function MarkdownMedia(props: MarkdownMediaProps) {
  const source = useMemo(
    () => resolveMarkdownMediaSource(props.src, props.threadId),
    [props.src, props.threadId],
  );
  const assetUrl = useAssetUrlState(
    source._tag === "Asset" ? props.environmentId : null,
    source._tag === "Asset" ? source.resource : null,
  );
  const name =
    props.alt?.trim() || props.title?.trim() || markdownMediaFileName(props.src) || "Media";
  const isVideo = isWorkspaceVideoPreviewPath(props.src);

  if (source._tag === "Direct") {
    return (
      <ResolvedMedia
        url={normalizeDirectUrl(source.url)}
        name={name}
        isVideo={isVideo}
        backgroundColor={props.backgroundColor}
        color={props.mutedColor}
        onPressImage={props.onPressImage}
      />
    );
  }
  if (assetUrl._tag === "Failure") {
    return <MediaUnavailable name={name} color={props.mutedColor} />;
  }
  if (assetUrl._tag === "Loading") {
    return (
      <LoadingMedia name={name} backgroundColor={props.backgroundColor} color={props.mutedColor} />
    );
  }
  return (
    <ResolvedMedia
      url={assetUrl.url}
      name={name}
      isVideo={isVideo}
      backgroundColor={props.backgroundColor}
      color={props.mutedColor}
      onPressImage={props.onPressImage}
    />
  );
}
