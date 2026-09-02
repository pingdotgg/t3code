import { useIsFocused } from "@react-navigation/native";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, View } from "react-native";

import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { VideoThumbnailImage } from "./VideoThumbnailImage";
import { useMediaActions, type MediaActionsSource } from "../lib/mediaActions";
import { MediaActionsMenu } from "./MediaActionsMenu";

/** Loads only after Play or opening the viewer. Source replacement never starts playback itself. */
function LoadedMediaVideo(props: {
  readonly uri: string;
  readonly resolvePlaybackUri?: () => Promise<string | null>;
  readonly playRequested: boolean;
  readonly paused: boolean;
}) {
  const focused = useIsFocused();
  const active = useRef(focused && AppState.currentState === "active");
  const [attempt, setAttempt] = useState(0);
  // Expo's Android player also reports completed playback as idle.
  const [loadState, setLoadState] = useState<"pending" | "complete" | "error">("pending");
  const player = useVideoPlayer(null, (player) => {
    player.staysActiveInBackground = false;
    player.bufferOptions = { preferredForwardBufferDuration: 5 };
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const loadSource = useEffectEvent(async (signal: AbortSignal) => {
    const uri = props.resolvePlaybackUri ? await props.resolvePlaybackUri() : props.uri;
    if (signal.aborted) return;
    if (uri === null) throw new Error("Video unavailable");
    player.pause();
    await player.replaceAsync({ uri, contentType: "progressive" });
    if (!signal.aborted && props.playRequested && active.current) player.play();
  });

  useEffect(() => {
    active.current = focused && !props.paused && AppState.currentState === "active";
    if (!active.current) player.pause();
    const subscription = AppState.addEventListener("change", (state) => {
      active.current = focused && !props.paused && state === "active";
      if (!active.current) player.pause();
    });
    return () => subscription.remove();
  }, [focused, player, props.paused]);

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
          <ActivityIndicator color="#ffffff" accessibilityLabel="Loading video" />
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
  readonly paused?: boolean;
  readonly onExpand?: () => void;
  readonly actionsSource?: MediaActionsSource;
}

function MediaVideoPlayerContent(props: MediaVideoPlayerProps) {
  const mediaActions = useMediaActions(props.actionsSource);
  const [playbackUri, setPlaybackUri] = useState<string | null>(props.expanded ? props.uri : null);
  // Keep an opened player mounted while signing or reconnecting temporarily has no usable URL.
  if (playbackUri === null && props.expanded && props.uri !== null) setPlaybackUri(props.uri);

  return (
    <View
      collapsable={false}
      className="overflow-hidden rounded-[10px] bg-black"
      style={props.expanded ? { flex: 1 } : { width: "100%", maxWidth: 480, aspectRatio: 16 / 9 }}
    >
      {playbackUri ? (
        <LoadedMediaVideo
          uri={props.uri ?? playbackUri}
          resolvePlaybackUri={props.resolvePlaybackUri}
          playRequested={!props.expanded}
          paused={(props.paused ?? false) || mediaActions.sharing}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Play ${props.name}`}
          accessibilityState={{ disabled: props.uri === null || props.unavailable === true }}
          disabled={props.uri === null || props.unavailable === true}
          onPress={() => setPlaybackUri(props.uri)}
          className="flex-1 items-center justify-center gap-2 px-4"
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
            <ActivityIndicator color="#ffffff" accessibilityLabel="Loading video" />
          ) : (
            <>
              <View className="size-12 items-center justify-center rounded-full bg-black/60">
                <SymbolView name="play" size={28} tintColor="#ffffff" type="monochrome" />
              </View>
              <AppText
                className="rounded bg-black/60 px-2 py-1 text-center text-xs text-white"
                numberOfLines={2}
              >
                {props.name}
              </AppText>
            </>
          )}
        </Pressable>
      )}
      {props.onExpand ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Expand ${props.name}`}
          onPress={() => {
            setPlaybackUri(null);
            props.onExpand?.();
          }}
          className="absolute right-1 top-1 min-h-11 min-w-11 items-center justify-center rounded-md bg-black/60 px-2"
        >
          <AppText className="text-xs text-white">Expand</AppText>
        </Pressable>
      ) : null}
      {props.actionsSource ? (
        <View className="absolute left-1 top-1">
          <MediaActionsMenu media={mediaActions} inModal={props.expanded} />
        </View>
      ) : null}
    </View>
  );
}

export function MediaVideoPlayer(props: MediaVideoPlayerProps) {
  return <MediaVideoPlayerContent key={props.thumbnailKey} {...props} />;
}
