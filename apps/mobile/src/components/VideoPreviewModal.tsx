import { useIsFocused } from "@react-navigation/native";
import { videoMimeType } from "@t3tools/shared/video";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { useMediaActions, type MediaActionsSource } from "../lib/mediaActions";
import {
  mediaVideoPreviewUri,
  mediaVideoThumbnailKey,
  type LocalVideoPreviewSource,
  type MediaVideoPreviewSource,
  type VideoPreviewSource,
} from "../lib/videoPreviewSource";
import { useAssetUrlState, useRefreshAssetUrl } from "../state/assets";
import { usePreparedConnection } from "../state/session";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { MediaActionsMenu } from "./MediaActionsMenu";
import { MediaSourceCaption } from "./MediaSourceCaption";
import { MediaVideoPlayer } from "./MediaVideoPlayer";

export type { VideoPreviewSource } from "../lib/videoPreviewSource";

interface PlaybackState {
  readonly uri: string | null;
  readonly resolvePlaybackUri?: () => Promise<string | null>;
  readonly unavailable: boolean;
  readonly error: string | null;
  readonly actionsSource: MediaActionsSource | undefined;
}

function useMediaPlayback(source: MediaVideoPreviewSource): PlaybackState {
  const environmentId = "environmentId" in source ? source.environmentId : null;
  const resource = "resource" in source ? source.resource : null;
  const connection = usePreparedConnection(environmentId);
  const asset = useAssetUrlState(environmentId, resource);
  const refreshAssetUrl = useRefreshAssetUrl(environmentId, resource);
  const uri = mediaVideoPreviewUri(source, asset._tag === "Success" ? asset.url : null);
  return {
    uri,
    ...(resource !== null
      ? { resolvePlaybackUri: async () => mediaVideoPreviewUri(source, await refreshAssetUrl()) }
      : {}),
    unavailable:
      uri === null &&
      environmentId !== null &&
      (connection._tag === "None" || asset._tag === "Failure"),
    error: null,
    actionsSource: source.actionsSource,
  };
}

function useLocalPlayback(source: LocalVideoPreviewSource): PlaybackState {
  const { attachment } = source;
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only a different file needs a new lease; a metadata update on the same
  // draft must not dispose the file Android is still playing.
  const attachmentRef = useRef(attachment);
  attachmentRef.current = attachment;
  const { id: attachmentId, fileUri } = attachment;
  useEffect(() => {
    setUri(null);
    setError(null);
    const controller = new AbortController();
    const loading = loadLocalAttachmentPreview(attachmentRef.current, controller.signal);
    void loading.then(
      (file) => {
        if (file === null) return;
        if (controller.signal.aborted) file.dispose();
        else setUri(file.uri);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load this video.");
        }
      },
    );
    return () => {
      controller.abort();
      void loading.then(
        (file) => file?.dispose(),
        () => undefined,
      );
    };
  }, [attachmentId, fileUri]);
  const mimeType = videoMimeType(attachment) ?? attachment.mimeType;
  return {
    uri,
    unavailable: error !== null,
    error,
    actionsSource: uri === null ? undefined : { name: attachment.name, mimeType, uri },
  };
}

function MediaPreviewModal(props: {
  readonly source: MediaVideoPreviewSource;
  readonly onRequestClose: () => void;
}) {
  return (
    <OpenVideoPreviewModal
      name={props.source.name}
      thumbnailKey={mediaVideoThumbnailKey(props.source)}
      playback={useMediaPlayback(props.source)}
      onRequestClose={props.onRequestClose}
    />
  );
}

function LocalPreviewModal(props: {
  readonly source: LocalVideoPreviewSource;
  readonly onRequestClose: () => void;
}) {
  return (
    <OpenVideoPreviewModal
      name={props.source.attachment.name}
      thumbnailKey={`local:${props.source.attachment.id}`}
      playback={useLocalPlayback(props.source)}
      onRequestClose={props.onRequestClose}
    />
  );
}

function OpenVideoPreviewModal(props: {
  readonly name: string;
  readonly thumbnailKey: string;
  readonly playback: PlaybackState;
  readonly onRequestClose: () => void;
}) {
  const { playback } = props;
  const insets = useSafeAreaInsets();
  const mediaActions = useMediaActions(playback.actionsSource, props.onRequestClose);

  useEffect(() => Keyboard.dismiss(), []);
  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={props.onRequestClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View
        className="flex-1 bg-black"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="min-h-14 flex-row items-center gap-3 pl-4 pr-2">
          <AppText className="flex-1 font-t3-medium text-base text-white" numberOfLines={2}>
            {props.name}
          </AppText>
          <MediaActionsMenu media={mediaActions} inModal />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close video"
            onPress={props.onRequestClose}
            className="size-12 items-center justify-center"
          >
            <SymbolView name="xmark" size={20} tintColor="#ffffff" type="monochrome" />
          </Pressable>
        </View>
        <MediaSourceCaption source={mediaActions.title} />
        {playback.uri === null && !playback.unavailable ? (
          <View className="flex-1 items-center justify-center gap-3 px-6">
            <ActivityIndicator color="#ffffff" />
            <AppText className="text-sm text-white/80">Loading video...</AppText>
          </View>
        ) : (
          <MediaVideoPlayer
            uri={playback.uri}
            resolvePlaybackUri={playback.resolvePlaybackUri}
            name={props.name}
            thumbnailKey={props.thumbnailKey}
            unavailable={playback.unavailable}
            paused={mediaActions.sharing}
            expanded
            autoPlay
          />
        )}
        {playback.error ? (
          <AppText accessibilityRole="alert" className="px-4 pb-3 text-sm text-white/80">
            {playback.error}
          </AppText>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save or share video"
          disabled={playback.uri === null || mediaActions.sharing}
          onPress={mediaActions.share}
          className="mx-4 my-3 min-h-12 items-center justify-center rounded-xl bg-white/15 px-4"
        >
          <AppText className="font-t3-medium text-base text-white">
            {mediaActions.sharing ? "Opening share sheet..." : "Save or share video"}
          </AppText>
        </Pressable>
      </View>
    </Modal>
  );
}

export function VideoPreviewModal(props: {
  readonly source: VideoPreviewSource | null;
  readonly onRequestClose: () => void;
}) {
  const isFocused = useIsFocused();
  const hasSource = props.source !== null;
  useEffect(() => {
    if (!isFocused && hasSource) props.onRequestClose();
  }, [isFocused, hasSource, props.onRequestClose]);
  const { source } = props;
  if (source === null || !isFocused) return null;
  return source.type === "local" ? (
    <LocalPreviewModal
      key={`local:${source.attachment.id}:${source.attachment.fileUri}`}
      source={source}
      onRequestClose={props.onRequestClose}
    />
  ) : (
    <MediaPreviewModal
      key={mediaVideoThumbnailKey(source)}
      source={source}
      onRequestClose={props.onRequestClose}
    />
  );
}
