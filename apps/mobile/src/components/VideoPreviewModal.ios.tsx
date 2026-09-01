import { useIsFocused } from "@react-navigation/native";
import { videoMimeType } from "@t3tools/shared/video";
import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { Alert, Keyboard } from "react-native";

import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { useAssetUrlState } from "../state/assets";
import { usePreparedConnection } from "../state/session";
import type { VideoPreviewSource } from "./VideoPreviewModal";

export type { VideoPreviewSource } from "./VideoPreviewModal";

const NativeControls = requireNativeModule<{
  presentVideo(
    uri: string,
    title: string,
    sourceIdentifier: string,
    identifier: string,
  ): Promise<void>;
  dismissVideo(identifier: string): Promise<void>;
}>("T3NativeControls");

function NativeVideoPreview(props: {
  readonly source: VideoPreviewSource;
  readonly onRequestClose: () => void;
}) {
  const { source } = props;
  const { attachment } = source;
  const identifier = useId();
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const environmentId = source.type === "remote" ? source.environmentId : null;
  const preparedConnection = usePreparedConnection(environmentId);
  const mimeType = videoMimeType(attachment) ?? attachment.mimeType;
  const assetUrl = useAssetUrlState(
    environmentId,
    source.type === "remote"
      ? { _tag: "attachment", attachmentId: attachment.id, fileName: attachment.name, mimeType }
      : null,
  );
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(() =>
    assetUrl._tag === "Success" ? assetUrl.url : null,
  );
  const loadError =
    source.type === "remote" && playbackUrl === null
      ? preparedConnection._tag === "None"
        ? "Reconnect to this environment and open the video again."
        : assetUrl._tag === "Failure"
          ? "Could not load this video. Check the connection and try again."
          : null
      : null;

  useEffect(() => Keyboard.dismiss(), []);
  useEffect(() => {
    if (playbackUrl === null && assetUrl._tag === "Success") setPlaybackUrl(assetUrl.url);
  }, [playbackUrl, assetUrl]);
  useEffect(() => {
    if (!loadError) return;
    Alert.alert("Could not open video", loadError);
    onRequestClose();
  }, [loadError]);

  useEffect(() => {
    if (source.type === "remote" && playbackUrl === null) return;
    const controller = new AbortController();
    let ready = false;
    void (async () => {
      const file =
        source.type === "local"
          ? await loadLocalAttachmentPreview(source.attachment, controller.signal)
          : null;
      if (source.type === "local" && !file) return;
      try {
        if (controller.signal.aborted) return;
        ready = true;
        await NativeControls.presentVideo(
          file?.uri ?? playbackUrl!,
          attachment.name,
          source.sourceIdentifier ?? "",
          identifier,
        );
        if (!controller.signal.aborted) onRequestClose();
      } finally {
        // Native completion follows dismissal, so local playback keeps its file lease.
        file?.dispose();
      }
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      Alert.alert(
        "Could not open video",
        ready
          ? "This video couldn't be loaded or played. Check the connection, or touch and hold the attachment to save or share the original."
          : error instanceof Error
            ? error.message
            : "Could not load this video.",
      );
      onRequestClose();
    });
    return () => {
      controller.abort();
      void NativeControls.dismissVideo(identifier).catch(() => undefined);
    };
  }, [source, attachment.name, playbackUrl, identifier]);

  return null;
}

export function VideoPreviewModal(props: {
  readonly source: VideoPreviewSource | null;
  readonly onRequestClose: () => void;
}) {
  const isFocused = useIsFocused();
  const hasSource = props.source !== null;
  const onRequestClose = useEffectEvent(props.onRequestClose);
  useEffect(() => {
    if (!isFocused && hasSource) onRequestClose();
  }, [isFocused, hasSource]);

  if (!props.source || !isFocused) return null;
  return <NativeVideoPreview source={props.source} onRequestClose={props.onRequestClose} />;
}
