import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "./AppText";

function timestamp(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function AudioFilePreview(props: { uri: string; onRetry: () => void }) {
  const player = useAudioPlayer({ uri: props.uri }, { updateInterval: 500 });
  const status = useAudioPlayerStatus(player);
  const [seekError, setSeekError] = useState(false);
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back 15 seconds"
          disabled={!status.isLoaded}
          onPress={() => seek(Math.max(0, status.currentTime - 15))}
          className="p-4"
        >
          <Text className="text-foreground">−15s</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!status.isLoaded}
          onPress={() => {
            if (status.playing) player.pause();
            else if (status.didJustFinish || status.currentTime >= status.duration) seek(0, true);
            else player.play();
          }}
          className="rounded-xl bg-subtle px-6 py-4"
        >
          <Text className="text-foreground">
            {!status.isLoaded ? "Loading…" : status.playing ? "Pause" : "Play"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Forward 15 seconds"
          disabled={!status.isLoaded}
          onPress={() => seek(Math.min(status.duration, status.currentTime + 15))}
          className="p-4"
        >
          <Text className="text-foreground">+15s</Text>
        </Pressable>
      </View>
      {status.error || seekError ? (
        <View className="items-center gap-3">
          <Text className="text-center text-foreground">
            This audio could not be played. Try again or save it to open in another app.
          </Text>
          <Pressable accessibilityRole="button" onPress={props.onRetry} className="p-3">
            <Text className="text-foreground">Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
