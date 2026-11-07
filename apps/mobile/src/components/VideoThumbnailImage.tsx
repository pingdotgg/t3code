import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { Atom, AsyncResult } from "effect/reactivity";
import { Image } from "expo-image";
import { useIsFocused } from "@react-navigation/native";
import type { VideoThumbnail } from "expo-video";
import { useState } from "react";
import { StyleSheet } from "react-native";

import type { DraftComposerFileAttachment } from "../lib/composerImages";
import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { cachedVideoThumbnail, loadVideoThumbnail } from "../lib/videoThumbnails";

interface VideoThumbnailTarget {
  readonly cacheKey: string;
  readonly source: string | DraftComposerFileAttachment;
}

// Plain-object keys compare structurally (Effect `Equal`/`Hash`).
const videoThumbnailAtom = Atom.family((target: VideoThumbnailTarget) =>
  Atom.make(
    Effect.promise((signal) =>
      loadVideoThumbnail(
        target.cacheKey,
        async (sourceSignal) =>
          typeof target.source === "string"
            ? { uri: target.source, dispose: () => undefined }
            : loadLocalAttachmentPreview(target.source, sourceSignal),
        signal,
      ),
    ),
  ).pipe(Atom.withLabel(`video-thumbnail:${target.cacheKey}`)),
);

const noVideoThumbnail = Atom.make(AsyncResult.initial<VideoThumbnail | null>()).pipe(
  Atom.withLabel("video-thumbnail:none"),
);

export function VideoThumbnailImage(props: {
  readonly cacheKey: string;
  readonly source: string | DraftComposerFileAttachment | null;
  readonly contentFit?: "cover" | "contain";
}) {
  const { cacheKey, source } = props;
  // Extraction runs only while the screen is focused; leaving it interrupts the load.
  const isFocused = useIsFocused();
  const loaded = useAtomValue(
    source && isFocused ? videoThumbnailAtom({ cacheKey, source }) : noVideoThumbnail,
  );
  const thumbnail =
    (loaded._tag === "Success" ? loaded.value : null) ?? cachedVideoThumbnail(cacheKey);

  // iOS draws a frame object as soon as it is set, with whatever contentFit the view already
  // has, so the view lays out first and receives the frame in a later update.
  const [laidOut, setLaidOut] = useState(false);
  return (
    <Image
      onLayout={() => setLaidOut(true)}
      source={laidOut ? thumbnail : null}
      style={StyleSheet.absoluteFill}
      contentFit={props.contentFit ?? "cover"}
      recyclingKey={cacheKey}
      accessible={false}
    />
  );
}
