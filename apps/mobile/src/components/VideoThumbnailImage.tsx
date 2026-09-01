import { Image } from "expo-image";
import { useIsFocused } from "@react-navigation/native";
import type { VideoThumbnail } from "expo-video";
import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";

import type { DraftComposerFileAttachment } from "../lib/composerImages";
import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { cachedVideoThumbnail, loadVideoThumbnail } from "../lib/videoThumbnails";

export function VideoThumbnailImage(props: {
  readonly cacheKey: string;
  readonly source: string | DraftComposerFileAttachment | null;
}) {
  const { cacheKey, source } = props;
  const isFocused = useIsFocused();
  const [loaded, setLoaded] = useState<{ key: string; thumbnail: VideoThumbnail } | null>(null);
  const thumbnail = loaded?.key === cacheKey ? loaded.thumbnail : cachedVideoThumbnail(cacheKey);

  useEffect(() => {
    if (!source || !isFocused) return;
    const controller = new AbortController();
    void loadVideoThumbnail(
      cacheKey,
      async (signal) =>
        typeof source === "string"
          ? { uri: source, dispose: () => undefined }
          : loadLocalAttachmentPreview(source, signal),
      controller.signal,
    ).then((thumbnail) => {
      if (thumbnail && !controller.signal.aborted) setLoaded({ key: cacheKey, thumbnail });
    });
    return () => controller.abort();
  }, [cacheKey, source, isFocused]);

  return thumbnail ? (
    <Image
      source={thumbnail}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      recyclingKey={cacheKey}
      accessible={false}
    />
  ) : null;
}
