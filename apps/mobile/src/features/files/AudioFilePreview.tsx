import { Button } from "../../components/ui/Button";
import { useAudioPlayerStatus } from "expo-audio";
import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useFullscreenVideoOpen, useMediaAudioSessionHold } from "../../lib/videoAudioSession";
import { createAudioPlaybackSession } from "../../lib/audioSession";
import { usePlaybackAudioPlayer } from "../voice-input/usePlaybackAudioPlayer";

function timestamp(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function AudioFilePreview(props: { uri: string; onRetry: () => void }) {
  const player = usePlaybackAudioPlayer(props.uri);
  const status = useAudioPlayerStatus(player);
  const [playbackRequested, setPlaybackRequested] = useState(false);
  const playback = createAudioPlaybackSession(player, false, setPlaybackRequested);
  const [seekError, setSeekError] = useState(false);
  // Video teardown deactivates the shared iOS session, which would stop this player.
  useMediaAudioSessionHold(status.playing);
  const fullscreenVideoOpen = useFullscreenVideoOpen();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the shared audio session in step with the native player status and fullscreen video
  useEffect(() => {
    if (fullscreenVideoOpen || status.didJustFinish || status.error) playback.pause();
    else playback.playingChanged(status.playing);
  }, [fullscreenVideoOpen, status.didJustFinish, status.error, status.playing, playback]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to AppState to pause playback in the background, and pauses on cleanup
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") playback.pause();
    });
    return () => {
      subscription.remove();
      playback.pause();
    };
  }, [playback]);
  const seek = (seconds: number) => {
    setSeekError(false);
    void player.seekTo(seconds).catch(() => setSeekError(true));
  };
  return (
    <View className="flex-1 items-center justify-center gap-5 p-6">
      <Text className="text-foreground-muted">
        {timestamp(status.currentTime)} / {timestamp(status.duration)}
      </Text>
      <View className="flex-row items-center gap-4">
        <Button
          label="−15s"
          tone="text"
          accessibilityLabel="Back 15 seconds"
          disabled={!status.isLoaded}
          onPress={() => seek(Math.max(0, status.currentTime - 15))}
        />
        <Button
          label={
            playbackRequested || status.playing ? "Pause" : !status.isLoaded ? "Loading…" : "Play"
          }
          tone="secondary"
          disabled={!status.isLoaded && !playbackRequested}
          onPress={() => {
            if (status.playing || playback.requested) playback.pause();
            else {
              setSeekError(false);
              void playback
                .play(
                  status.didJustFinish || status.currentTime >= status.duration
                    ? () => player.seekTo(0)
                    : undefined,
                )
                .catch(() => setSeekError(true));
            }
          }}
        />
        <Button
          label="+15s"
          tone="text"
          accessibilityLabel="Forward 15 seconds"
          disabled={!status.isLoaded}
          onPress={() => seek(Math.min(status.duration, status.currentTime + 15))}
        />
      </View>
      {status.error || seekError ? (
        <View className="items-center gap-3">
          <Text className="text-center text-foreground">
            This audio could not be played. Try again or save it to open in another app.
          </Text>
          <View className="items-center">
            <Button label="Try again" tone="secondary" onPress={props.onRetry} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
