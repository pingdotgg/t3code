import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "./ui/AppActivityIndicator";
import { AppText } from "./ui/AppText";
import { SymbolView } from "./ui/AppSymbol";
import { VideoThumbnailImage } from "./VideoThumbnailImage";
import { useMediaActions } from "../state/mediaActions";
import { fitVideoFrame } from "../lib/videoFrameFit";
import { loadVideoThumbnail } from "../lib/videoThumbnails";
import { type MediaActionsSource } from "../lib/mediaActionsSource";
import { useMediaVideoPlayback } from "../lib/useMediaVideoPlayback";
import { MediaActionsMenu } from "./MediaActionsMenu";
import { createAudioPlaybackSession } from "../lib/audioSession";

function LoadedMediaVideo(props: {
  readonly uri: string;
  readonly resolvePlaybackUri?: () => Promise<string | null>;
  readonly playRequested: boolean;
  readonly paused: boolean;
  readonly visible: boolean;
  readonly onPlaybackStart?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  // Expo's Android player also reports completed playback as idle.
  const [loadState, setLoadState] = useState<"pending" | "complete" | "error">("pending");
  const player = useVideoPlayer(null, (player) => {
    player.staysActiveInBackground = false;
    player.bufferOptions = { preferredForwardBufferDuration: 5 };
  });
  const playback = createAudioPlaybackSession(player, true);
  const { active, fullscreen, createPlayRequest, onFullscreenEnter, onFullscreenExit } =
    useMediaVideoPlayback(player, props, playback);
  const previousPlaybackRequested = useRef(false);
  const onPlaybackStart = useEffectEvent(() => props.onPlaybackStart?.());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to native video player events to keep the shared audio session in step
  useEffect(() => {
    const subscription = player.addListener("playingChange", ({ isPlaying }) => {
      if (isPlaying && !active.current && !fullscreen.current) playback.pause();
      else playback.playingChanged(isPlaying);
    });
    const requested = player.addListener("playbackRequestedChange", ({ isPlaybackRequested }) => {
      const wasPlaybackRequested = previousPlaybackRequested.current;
      previousPlaybackRequested.current = isPlaybackRequested;
      if (!isPlaybackRequested) {
        if (playback.requested) playback.pause();
      } else if (!active.current && !fullscreen.current) playback.pause();
      else {
        if (!wasPlaybackRequested) onPlaybackStart();
        playback.playingChanged(true);
      }
    });
    const ended = player.addListener("playToEnd", () => playback.pause());
    const failed = player.addListener("statusChange", ({ status }) => {
      if (status === "error") playback.pause();
    });
    return () => {
      subscription.remove();
      requested.remove();
      ended.remove();
      failed.remove();
      playback.pause();
      previousPlaybackRequested.current = false;
    };
  }, [active, fullscreen, player, playback]);
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const loadSource = useEffectEvent(async (signal: AbortSignal) => {
    const playIfUninterrupted = createPlayRequest();
    const uri = props.resolvePlaybackUri ? await props.resolvePlaybackUri() : props.uri;
    if (signal.aborted) return;
    if (uri === null) throw new Error("Video unavailable");
    playback.pause();
    previousPlaybackRequested.current = false;
    await player.replaceAsync({ uri, contentType: "progressive" });
    if (!signal.aborted && props.playRequested) await playIfUninterrupted();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the video source into the native player and aborts the load on cleanup
  useEffect(() => {
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- Starting a native media load publishes pending before its async result.
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A play request or Retry (attempt) reloads the source into the same player.
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
        onFullscreenEnter={onFullscreenEnter}
        onFullscreenExit={onFullscreenExit}
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
  readonly visible?: boolean;
  readonly unavailable?: boolean;
  readonly expanded?: boolean;
  /** Fill the parent and size the frame to the video's shape instead of a fixed 16:9 slot. */
  readonly fitToVideo?: boolean;
  readonly autoPlay?: boolean;
  readonly paused?: boolean;
  readonly onPlaybackStart?: () => void;
  readonly actionsSource?: MediaActionsSource;
  readonly borderRadius?: number;
}

function MediaVideoPlayerContent(props: MediaVideoPlayerProps) {
  const mediaActions = useMediaActions(props.actionsSource);
  const isFocused = useIsFocused();
  const [playbackUri, setPlaybackUri] = useState<string | null>(props.expanded ? props.uri : null);
  // Keep an opened player mounted while signing or reconnecting temporarily has no usable URL.
  if (playbackUri === null && props.expanded && props.uri !== null) setPlaybackUri(props.uri);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [bounds, setBounds] = useState<{ width: number; height: number } | null>(null);
  const sizeSource = props.fitToVideo && isFocused && videoSize === null ? props.uri : null;
  // Queue before the poster so early Play cannot cancel the extraction that supplies frame dimensions.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads native thumbnail dimensions independently of the poster's lifetime
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
      style={[
        props.expanded
          ? { flex: 1 }
          : (fittedFrame ?? { width: "100%", maxWidth: 480, aspectRatio: 16 / 9 }),
        props.borderRadius === undefined ? null : { borderRadius: props.borderRadius },
      ]}
    >
      {playbackUri ? (
        <LoadedMediaVideo
          uri={props.uri ?? playbackUri}
          resolvePlaybackUri={props.resolvePlaybackUri}
          playRequested={!props.expanded || props.autoPlay === true}
          paused={(props.paused ?? false) || mediaActions.sharing}
          visible={props.visible ?? true}
          onPlaybackStart={props.onPlaybackStart}
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
              if (props.uri !== null && !props.unavailable) {
                props.onPlaybackStart?.();
                setPlaybackUri(props.uri);
              }
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
