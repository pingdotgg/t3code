import * as Dialog from "./ui/Dialog";
import { useIsFocused } from "@react-navigation/native";
import { requireNativeModule } from "expo";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { Keyboard } from "react-native";

import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { fullscreenVideoClosed, fullscreenVideoOpened } from "../lib/videoAudioSession";
import { mediaVideoPreviewUri, type VideoPreviewSource } from "../lib/videoPreviewSource";
import { useAssetUrlState, useRefreshAssetUrl } from "../state/assets";
import { usePreparedConnection } from "../state/session";
import {
  acquireAudioSession,
  activateAudioSession,
  isAudioSessionOwner,
  releaseAudioSession,
} from "../lib/audioSession";

export type { VideoPreviewSource } from "../lib/videoPreviewSource";

const NativeControls = requireNativeModule<{
  presentVideo(
    uri: string,
    title: string,
    sourceIdentifier: string,
    identifier: string,
  ): Promise<void>;
  dismissVideo(identifier: string): Promise<void>;
  addListener(
    event: "videoPlaybackChange",
    listener: (event: { identifier: string; isPlaying: boolean }) => void,
  ): { remove(): void };
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
    fullscreenVideoOpened();
    return () => fullscreenVideoClosed();
  }, []);
  useEffect(() => {
    if (playbackUrl === null && resolvedUrl !== null) setPlaybackUrl(resolvedUrl);
  }, [playbackUrl, resolvedUrl]);
  useEffect(() => {
    if (!loadError) return;
    Dialog.alert("Could not open video", loadError);
    onRequestClose();
  }, [loadError]);

  useEffect(() => {
    if (localAttachment === null && playbackUrl === null) return;
    const controller = new AbortController();
    let token: ReturnType<typeof acquireAudioSession> | null = null;
    const release = () => {
      if (token) void releaseAudioSession(token).catch(() => {});
      token = null;
    };
    const acquire = () => {
      const next = acquireAudioSession("playback", () => {
        release();
        void NativeControls.dismissVideo(identifier).catch(() => {});
      });
      if (!isAudioSessionOwner(next)) {
        void NativeControls.dismissVideo(identifier).catch(() => {});
        return null;
      }
      token = next;
      return next;
    };
    const subscription = NativeControls.addListener("videoPlaybackChange", (event) => {
      if (event.identifier !== identifier || controller.signal.aborted) return;
      if (event.isPlaying) {
        if (!token) acquire();
      } else release();
    });
    let ready = false;
    void (async () => {
      const file =
        localAttachment !== null
          ? await loadLocalAttachmentPreview(localAttachment, controller.signal)
          : null;
      if (localAttachment !== null && !file) return;
      if (controller.signal.aborted) {
        file?.dispose();
        return;
      }
      const current = acquire();
      if (!current || !(await activateAudioSession(current, true)) || controller.signal.aborted) {
        release();
        file?.dispose();
        if (!controller.signal.aborted) onRequestClose();
        return;
      }
      ready = true;
      const presented = await settlePromise(() =>
        NativeControls.presentVideo(
          file?.uri ?? playbackUrl!,
          name,
          source.sourceIdentifier ?? "",
          identifier,
        ),
      );
      // Native completion follows dismissal, so local playback keeps its file lease.
      file?.dispose();
      release();
      if (AsyncResult.isFailure(presented)) throw squashAtomCommandFailure(presented);
      if (!controller.signal.aborted) onRequestClose();
    })().catch((error: unknown) => {
      release();
      if (controller.signal.aborted) return;
      // AVKit gives no retry, so re-mint now; the cached URL may simply have expired.
      if (ready) void refreshAssetUrl();
      Dialog.alert(
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
      subscription.remove();
      release();
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
