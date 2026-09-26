import { useIsFocused } from "@react-navigation/native";
import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { Alert, Keyboard } from "react-native";

import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { mediaVideoPreviewUri, type VideoPreviewSource } from "../lib/videoPreviewSource";
import { useAssetUrlState, useRefreshAssetUrl } from "../state/assets";
import { usePreparedConnection } from "../state/session";

export type { VideoPreviewSource } from "../lib/videoPreviewSource";

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
  const localAttachment = source.type === "local" ? source.attachment : null;
  const identifier = useId();
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const environmentId =
    source.type === "media" && "environmentId" in source ? source.environmentId : null;
  const resource = source.type === "media" && "resource" in source ? source.resource : null;
  const preparedConnection = usePreparedConnection(environmentId);
  const assetUrl = useAssetUrlState(environmentId, resource);
  const refreshAssetUrl = useEffectEvent(useRefreshAssetUrl(environmentId, resource));
  const name = source.type === "media" ? source.name : source.attachment.name;
  // The first minted URL is kept so a background refresh does not restart playback.
  const resolvedUrl =
    source.type === "media"
      ? mediaVideoPreviewUri(source, assetUrl._tag === "Success" ? assetUrl.url : null)
      : null;
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(resolvedUrl);
  const loadError =
    resource !== null && playbackUrl === null
      ? preparedConnection._tag === "None"
        ? "Reconnect to this environment and open the video again."
        : assetUrl._tag === "Failure"
          ? "Could not load this video. Check the connection and try again."
          : null
      : null;

  useEffect(() => Keyboard.dismiss(), []);
  useEffect(() => {
    if (playbackUrl === null && resolvedUrl !== null) setPlaybackUrl(resolvedUrl);
  }, [playbackUrl, resolvedUrl]);
  useEffect(() => {
    if (!loadError) return;
    Alert.alert("Could not open video", loadError);
    onRequestClose();
  }, [loadError]);

  useEffect(() => {
    if (localAttachment === null && playbackUrl === null) return;
    const controller = new AbortController();
    let ready = false;
    void (async () => {
      const file =
        localAttachment !== null
          ? await loadLocalAttachmentPreview(localAttachment, controller.signal)
          : null;
      if (localAttachment !== null && !file) return;
      try {
        if (controller.signal.aborted) return;
        ready = true;
        await NativeControls.presentVideo(
          file?.uri ?? playbackUrl!,
          name,
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
      // AVKit gives no retry, so re-mint now; the cached URL may simply have expired.
      if (ready) void refreshAssetUrl();
      Alert.alert(
        "Could not open video",
        ready
          ? "This video couldn't be loaded or played. Check the connection, or touch and hold the video to save or share the original."
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
  }, [localAttachment, name, source.sourceIdentifier, playbackUrl, identifier]);

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
