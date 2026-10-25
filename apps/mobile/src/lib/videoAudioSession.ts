import { requireOptionalNativeModule } from "expo";
import { useEffect, useSyncExternalStore } from "react";
import { Platform } from "react-native";

const nativeControls = requireOptionalNativeModule<{
  releaseVideoAudioSession(): Promise<void>;
}>("T3NativeControls");

// Keep the session through seeks, buffering, and brief gaps between players.
const RELEASE_DELAY_MS = 1_000;

let playingCount = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

export function mediaPlaybackStarted(): void {
  playingCount += 1;
}

/** expo-video never deactivates iOS playback, preventing interrupted apps from resuming. Include audio previews to avoid stopping them. */
export function mediaPlaybackStopped(): void {
  playingCount -= 1;
  if (playingCount > 0 || Platform.OS !== "ios") return;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    if (playingCount > 0) return;
    void nativeControls?.releaseVideoAudioSession().catch(() => undefined);
  }, RELEASE_DELAY_MS);
}

let fullscreenCount = 0;
const fullscreenListeners = new Set<() => void>();

export function fullscreenVideoOpened(): void {
  fullscreenCount += 1;
  for (const listener of fullscreenListeners) listener();
}

export function fullscreenVideoClosed(): void {
  fullscreenCount -= 1;
  for (const listener of fullscreenListeners) listener();
}

export function subscribeFullscreenVideo(listener: () => void): () => void {
  fullscreenListeners.add(listener);
  return () => {
    fullscreenListeners.delete(listener);
  };
}

export function isFullscreenVideoOpen(): boolean {
  return fullscreenCount > 0;
}

export function useFullscreenVideoOpen(): boolean {
  return useSyncExternalStore(subscribeFullscreenVideo, isFullscreenVideoOpen);
}

export function useMediaAudioSessionHold(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    mediaPlaybackStarted();
    return () => mediaPlaybackStopped();
  }, [active]);
}
