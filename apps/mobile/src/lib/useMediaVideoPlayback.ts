import { useIsFocused } from "@react-navigation/native";
import { useEvent } from "expo";
import type { VideoPlayer } from "expo-video";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

import { useFullscreenVideoOpen, useMediaAudioSessionHold } from "./videoAudioSession";

export function useMediaVideoPlayback(
  player: VideoPlayer,
  options: { readonly paused: boolean; readonly visible?: boolean },
  playback: { play(): Promise<void>; pause(): void },
) {
  const focused = useIsFocused();
  const fullscreenVideoOpen = useFullscreenVideoOpen();
  const paused = options.paused || fullscreenVideoOpen || options.visible === false;
  const active = useRef(focused && !paused && AppState.currentState === "active");
  const fullscreen = useRef(false);
  const interruption = useRef(0);
  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });
  useMediaAudioSessionHold(isPlaying);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to AppState for the player's lifetime and pauses the native player when unfocused or backgrounded
  useEffect(() => {
    active.current = focused && !paused && AppState.currentState === "active";
    if (!active.current) interruption.current += 1;
    if (!focused || paused || (!active.current && !fullscreen.current)) playback.pause();
    // Native background handling distinguishes Android's fullscreen activity
    // from leaving the app; React Native reports both as background.
    const subscription = AppState.addEventListener("change", (state) => {
      active.current = focused && !paused && state === "active";
      if (!active.current) interruption.current += 1;
      if (state === "inactive" || (state === "background" && !fullscreen.current)) playback.pause();
    });
    return () => subscription.remove();
  }, [focused, playback, paused]);

  const createPlayRequest = useCallback(() => {
    const requestedAt = interruption.current;
    const requestedWhileActive = active.current;
    // Returning to the content must not revive playback interrupted during loading.
    return () => {
      if (requestedWhileActive && active.current && requestedAt === interruption.current)
        return playback.play();
    };
  }, [playback]);

  const onFullscreenEnter = useCallback(() => {
    fullscreen.current = true;
  }, []);
  const onFullscreenExit = useCallback(() => {
    fullscreen.current = false;
    if (!active.current) playback.pause();
  }, [playback]);

  return { active, fullscreen, createPlayRequest, onFullscreenEnter, onFullscreenExit };
}
