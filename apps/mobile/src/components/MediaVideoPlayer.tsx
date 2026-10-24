import { useIsFocused } from "@react-navigation/native";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";

import { AppActivityIndicator } from "./ui/AppActivityIndicator";
import { AppText } from "./ui/AppText";
import { SymbolView } from "./ui/AppSymbol";
import { VideoThumbnailImage } from "./VideoThumbnailImage";
import { useMediaActions } from "../state/mediaActions";
import { fitVideoFrame } from "../lib/videoFrameFit";
import { loadVideoThumbnail } from "../lib/videoThumbnails";
import { type MediaActionsSource } from "../lib/mediaActionsSource";
import { useFullscreenVideoOpen, useMediaAudioSessionHold } from "../lib/videoAudioSession";
import { MediaActionsMenu } from "./MediaActionsMenu";

function LoadedMediaVideo(props: {
  readonly uri: string;
  readonly resolvePlaybackUri?: () => Promise<string | null>;
  readonly playRequested: boolean;
  readonly paused: boolean;
}) {
  const focused = useIsFocused();
  const fullscreenVideoOpen = useFullscreenVideoOpen();
  const paused = props.paused || fullscreenVideoOpen;
  const active = useRef(focused && AppState.currentState === "active");
  const fullscreen = useRef(false);
  const [attempt, setAttempt] = useState(0);
  // Expo's Android player also reports completed playback as idle.
  const [loadState, setLoadState] = useState<"pending" | "complete" | "error">("pending");
  const player = useVideoPlayer(null, (player) => {
    player.staysActiveInBackground = false;
    player.bufferOptions = { preferredForwardBufferDuration: 5 };
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });
  useMediaAudioSessionHold(isPlaying);
  const loadSource = useEffectEvent(async (signal: AbortSignal) => {
    const uri = props.resolvePlaybackUri ? await props.resolvePlaybackUri() : props.uri;
    if (signal.aborted) return;
    if (uri === null) throw new Error("Video unavailable");
    player.pause();
    await player.replaceAsync({ uri, contentType: "progressive" });
    if (!signal.aborted && props.playRequested && active.current) player.play();
  });

  useEffect(() => {
    active.current = focused && !paused && AppState.currentState === "active";
    if (!focused || paused || (!active.current && !fullscreen.current)) player.pause();
    // Native background handling distinguishes Android's fullscreen activity
    // from leaving the app; React Native reports both as background.
    const subscription = AppState.addEventListener("change", (state) => {
      active.current = focused && !paused && state === "active";
      if (state === "inactive" || (state === "background" && !fullscreen.current)) player.pause();
    });
    return () => subscription.remove();
  }, [focused, player, paused]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadState("pending");
    // A renewed signature is used on Retry, not as a reason to reset the native player.
    void loadSource(controller.signal).then(
      () => {
        if (!controller.signal.aborted) setLoadState("complete");
      },
      () => {
        if (!controller.signal.aborted) setLoadState("error");
      },
    );
    return () => controller.abort();
  }, [player, props.playRequested, attempt]);

  return (
    <View collapsable={false} style={{ flex: 1 }}>
      <VideoView
        player={player}
        style={{ width: "100%", height: "100%" }}
        surfaceType="textureView"
        nativeControls
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
        onFullscreenEnter={() => {
          fullscreen.current = true;
        }}
        onFullscreenExit={() => {
          fullscreen.current = false;
        }}
        allowsPictureInPicture={false}
      />
      {loadState === "error" || (loadState === "complete" && status === "error") ? (
        <View className="absolute inset-0 items-center justify-center gap-2 bg-black px-4">
          <AppText className="text-center text-sm text-white/80">Video unavailable</AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry video"
            onPress={() => setAttempt((value) => value + 1)}
            className="min-h-11 justify-center px-4"
          >
            <AppText className="text-sm text-white">Retry</AppText>
          </Pressable>
        </View>
      ) : loadState === "pending" || status === "loading" ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator color="#ffffff" accessibilityLabel="Loading video" />
        </View>
      ) : null}
    </View>
  );
}

interface MediaVideoPlayerProps {
  readonly uri: string | null;
  readonly resolvePlaybackUri?: () => Promise<string | null>;
  readonly name: string;
  readonly thumbnailKey: string;
  readonly thumbnailVisible?: boolean;
  readonly unavailable?: boolean;
  readonly expanded?: boolean;
  /** Fill the parent and size the frame to the video's shape instead of a fixed 16:9 slot. */
  readonly fitToVideo?: boolean;
  readonly autoPlay?: boolean;
  readonly paused?: boolean;
  readonly actionsSource?: MediaActionsSource;
}

function MediaVideoPlayerContent(props: MediaVideoPlayerProps) {
  const mediaActions = useMediaActions(props.actionsSource);
  const [playbackUri, setPlaybackUri] = useState<string | null>(props.expanded ? props.uri : null);
  // Keep an opened player mounted while signing or reconnecting temporarily has no usable URL.
  if (playbackUri === null && props.expanded && props.uri !== null) setPlaybackUri(props.uri);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [bounds, setBounds] = useState<{ width: number; height: number } | null>(null);
  const sizeSource = props.fitToVideo && videoSize === null ? props.uri : null;
  // Layout effect so this request queues ahead of the poster's passive one. Otherwise tapping Play
  // unmounts the poster, aborts the extraction it started, and this load begins again from scratch.
  useLayoutEffect(() => {
    if (sizeSource === null) return;
    // Thumbnails are oriented like the displayed frame, unlike VideoTrack.size.
    const controller = new AbortController();
    void loadVideoThumbnail(
      props.thumbnailKey,
      async () => ({ uri: sizeSource, dispose: () => undefined }),
      controller.signal,
    ).then((thumbnail) => {
      if (thumbnail && !controller.signal.aborted) {
        setVideoSize({ width: thumbnail.width, height: thumbnail.height });
      }
    });
    return () => controller.abort();
  }, [props.thumbnailKey, sizeSource]);
  const fittedFrame =
    props.fitToVideo && videoSize && bounds ? fitVideoFrame(videoSize, bounds, 480) : null;

  const frame = (
    <View
      collapsable={false}
      className="overflow-hidden rounded-[10px] bg-black"
      style={
        props.expanded
          ? { flex: 1 }
          : (fittedFrame ?? { width: "100%", maxWidth: 480, aspectRatio: 16 / 9 })
      }
    >
      {playbackUri ? (
        <LoadedMediaVideo
          uri={props.uri ?? playbackUri}
          resolvePlaybackUri={props.resolvePlaybackUri}
          playRequested={!props.expanded || props.autoPlay === true}
          paused={(props.paused ?? false) || mediaActions.sharing}
        />
      ) : (
        <MediaActionsMenu media={mediaActions} inModal={props.expanded} style={{ flex: 1 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Play ${props.name}`}
            accessibilityHint={
              mediaActions.actions.length > 0 ? "Touch and hold for media actions" : undefined
            }
            accessibilityState={{ disabled: props.uri === null || props.unavailable === true }}
            // Stays pressable so the long-press menu still opens on a failed or unsigned tile.
            onPress={() => {
              if (props.uri !== null && !props.unavailable) setPlaybackUri(props.uri);
            }}
            className="flex-1 items-center justify-center px-4"
          >
            {!props.unavailable ? (
              <VideoThumbnailImage
                cacheKey={props.thumbnailKey}
                source={props.thumbnailVisible === false ? null : props.uri}
                contentFit="contain"
              />
            ) : null}
            {props.unavailable ? (
              <AppText className="text-sm text-white/80">Video unavailable</AppText>
            ) : props.uri === null ? (
              <AppActivityIndicator color="#ffffff" accessibilityLabel="Loading video" />
            ) : (
              <View className="size-12 items-center justify-center rounded-full bg-black/60">
                <SymbolView name="play" size={28} tintColor="#ffffff" type="monochrome" />
              </View>
            )}
            {props.uri !== null && !props.unavailable ? (
              <AppText
                className="absolute right-2 bottom-2 max-w-[75%] rounded bg-black/60 px-2 py-1 text-right text-xs text-white"
                numberOfLines={1}
              >
                {props.name}
              </AppText>
            ) : null}
          </Pressable>
        </MediaActionsMenu>
      )}
    </View>
  );
  if (!props.fitToVideo) return frame;
  return (
    <View
      className="flex-1 items-center justify-center self-stretch"
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setBounds({ width, height });
      }}
    >
      {frame}
    </View>
  );
}

export function MediaVideoPlayer(props: MediaVideoPlayerProps) {
  return <MediaVideoPlayerContent key={props.thumbnailKey} {...props} />;
}
