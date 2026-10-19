import { Button } from "../../components/ui/Button";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useFullscreenVideoOpen, useMediaAudioSessionHold } from "../../lib/videoAudioSession";

function timestamp(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function AudioFilePreview(props: { uri: string; onRetry: () => void }) {
  const player = useAudioPlayer({ uri: props.uri }, { updateInterval: 500 });
  const status = useAudioPlayerStatus(player);
  const [seekError, setSeekError] = useState(false);
  // Video teardown deactivates the shared iOS session, which would stop this player.
  useMediaAudioSessionHold(status.playing);
  const fullscreenVideoOpen = useFullscreenVideoOpen();
  useEffect(() => {
    if (fullscreenVideoOpen) player.pause();
  }, [fullscreenVideoOpen, player]);
  const seek = (seconds: number, play = false) => {
    setSeekError(false);
    void player
      .seekTo(seconds)
      .then(() => {
        if (play) player.play();
      })
      .catch(() => setSeekError(true));
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
          label={!status.isLoaded ? "Loading…" : status.playing ? "Pause" : "Play"}
          tone="secondary"
          disabled={!status.isLoaded}
          onPress={() => {
            if (status.playing) player.pause();
            else if (status.didJustFinish || status.currentTime >= status.duration) seek(0, true);
            else player.play();
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
