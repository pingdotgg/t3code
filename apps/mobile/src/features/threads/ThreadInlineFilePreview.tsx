import { useIsFocused } from "@react-navigation/native";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { useAudioPlayerStatus } from "expo-audio";
import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { filePreviewKey } from "../../lib/filePreviewGallery";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useFullscreenVideoOpen, useMediaAudioSessionHold } from "../../lib/videoAudioSession";
import { useRefreshAssetUrl } from "../../state/assets";
import { useThreadMediaVisible } from "./ThreadMediaVisibility";
import {
  acquireAudioSession,
  activateAudioSession,
  isAudioSessionOwner,
  pauseAudioPlayer,
  releaseAudioSession,
} from "../../lib/audioSession";
import { usePlaybackAudioPlayer } from "../voice-input/usePlaybackAudioPlayer";

type PreviewProps = {
  readonly source: FilePreviewSource;
  readonly sizeBytes?: number;
  readonly onOpen: () => void;
  readonly onPlaybackStart?: () => void;
  readonly onLongPress?: () => void;
};

function FileCardHeader(props: PreviewProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${props.source.name}`}
      onPress={props.onOpen}
      onLongPress={props.onLongPress}
      className="h-[72px] flex-row items-center gap-3 p-3 active:bg-subtle"
    >
      <View className="h-12 w-10 shrink-0 items-center justify-center rounded-lg bg-subtle">
        <PierreEntryIcon path={props.source.name ?? "file"} kind="file" size={26} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
          {props.source.name}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          Audio
          {props.sizeBytes !== undefined ? ` · ${formatAttachmentSize(props.sizeBytes)}` : ""}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-foreground-muted" />
    </Pressable>
  );
}

function timestamp(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function InlineAudio(props: PreviewProps & { readonly resolveUri: () => Promise<string | null> }) {
  // An empty source keeps native buffering off until the user explicitly plays.
  const player = usePlaybackAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const active = useRef(true);
  const requestGeneration = useRef(0);
  const playRequested = useRef(false);
  const audioToken = useRef<ReturnType<typeof acquireAudioSession> | null>(null);
  const [playbackRequested, setPlaybackRequested] = useState(false);
  const requestPlayback = (requested: boolean) => {
    playRequested.current = requested;
    setPlaybackRequested(requested);
    if (!requested) {
      requestGeneration.current += 1;
      setLoading(false);
      if (audioToken.current) {
        void releaseAudioSession(audioToken.current).catch(() => {});
        audioToken.current = null;
      }
    }
  };
  useMediaAudioSessionHold(status.playing);
  const fullscreenVideoOpen = useFullscreenVideoOpen();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the play request on fullscreen video, finish or error, and pauses the player for fullscreen
  useEffect(() => {
    if (fullscreenVideoOpen || status.didJustFinish || status.error) {
      // oxlint-disable-next-line react/set-state-in-effect -- Native completion and fullscreen takeover invalidate the pending playback request.
      requestPlayback(false);
    }
    if (fullscreenVideoOpen) pauseAudioPlayer(player);
  }, [fullscreenVideoOpen, status.didJustFinish, status.error, player, requestPlayback]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to AppState to pause audio in the background and releases the audio session on cleanup
  useEffect(() => {
    active.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        requestPlayback(false);
        pauseAudioPlayer(player);
      }
    });
    return () => {
      active.current = false;
      playRequested.current = false;
      requestGeneration.current += 1;
      if (audioToken.current) {
        void releaseAudioSession(audioToken.current).catch(() => {});
        audioToken.current = null;
      }
      subscription.remove();
    };
  }, [player, requestPlayback]);
  const toggle = () => {
    if (status.playing || playRequested.current) {
      requestPlayback(false);
      return pauseAudioPlayer(player);
    }
    const token = acquireAudioSession(
      "playback",
      () => {
        requestPlayback(false);
        pauseAudioPlayer(player);
      },
      () => {
        try {
          pauseAudioPlayer(player);
        } catch {}
      },
    );
    if (!isAudioSessionOwner(token)) return;
    props.onPlaybackStart?.();
    audioToken.current = token;
    requestPlayback(true);
    const generation = ++requestGeneration.current;
    const isCurrentRequest = () =>
      active.current &&
      playRequested.current &&
      requestGeneration.current === generation &&
      isAudioSessionOwner(token);
    setLoading(true);
    setError(false);
    void Promise.resolve()
      .then(async () => {
        if (!isCurrentRequest()) return;
        if (!status.isLoaded || status.error) {
          const uri = await props.resolveUri();
          if (!isCurrentRequest() || AppState.currentState !== "active") return;
          if (!uri) {
            requestPlayback(false);
            setError(true);
            return;
          }
          player.replace({ uri });
        } else if (status.didJustFinish || status.currentTime >= status.duration) {
          await player.seekTo(0);
        }
        if (!isCurrentRequest() || AppState.currentState !== "active") return;
        await activateAudioSession(token);
        if (isCurrentRequest() && AppState.currentState === "active") player.play();
      })
      .catch(() => {
        if (isCurrentRequest()) {
          requestPlayback(false);
          setError(true);
        }
      })
      .finally(() => {
        if (isCurrentRequest()) setLoading(false);
      });
  };
  const progress =
    status.duration > 0 ? Math.min(1, Math.max(0, status.currentTime / status.duration)) : 0;
  const playing = playbackRequested || status.playing;
  const busy = loading || (playbackRequested && status.isBuffering);
  return (
    <>
      <FileCardHeader
        {...props}
        onOpen={() => {
          requestPlayback(false);
          pauseAudioPlayer(player);
          props.onOpen();
        }}
      />
      <View className="h-14 flex-row items-center gap-3 px-3 pb-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            playing ? "Pause audio" : error || status.error ? "Retry audio" : "Play audio"
          }
          accessibilityState={{ busy }}
          onPress={toggle}
          className="h-11 w-11 items-center justify-center rounded-lg bg-subtle"
        >
          <SymbolView
            name={playing ? "pause" : "play"}
            size={18}
            tintColorClassName="accent-foreground"
          />
        </Pressable>
        <View className="min-w-0 flex-1 gap-2">
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: status.duration || 0, now: status.currentTime }}
            className="h-1 overflow-hidden rounded-full bg-subtle"
          >
            <View className="h-1 bg-foreground-muted" style={{ width: `${progress * 100}%` }} />
          </View>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {error || status.error
              ? "Unavailable · tap play to retry"
              : busy
                ? "Loading…"
                : `${timestamp(status.currentTime)} / ${status.isLoaded ? timestamp(status.duration) : "--:--"}`}
          </Text>
        </View>
      </View>
    </>
  );
}

function VisibleFilePreview(props: PreviewProps) {
  // Each mounted preview owns its source; feed streaming must not restart a fetch or player.
  const [source] = useState(props.source);
  const refresh = useRefreshAssetUrl(
    "environmentId" in source ? source.environmentId : null,
    "resource" in source ? source.resource : null,
  );
  const resolveUri = () => ("uri" in source ? Promise.resolve(source.uri) : refresh());
  return <InlineAudio {...props} resolveUri={resolveUri} />;
}

export function ThreadInlineFilePreview(props: PreviewProps) {
  const visible = useThreadMediaVisible();
  const focused = useIsFocused();
  return (
    <View
      className="my-1 overflow-hidden rounded-xl border border-border bg-card"
      style={{ width: 280, maxWidth: "100%" }}
    >
      {visible && focused ? (
        <VisibleFilePreview key={filePreviewKey(props.source)} {...props} />
      ) : (
        <>
          <FileCardHeader {...props} />
          <View className="h-14" />
        </>
      )}
    </View>
  );
}
