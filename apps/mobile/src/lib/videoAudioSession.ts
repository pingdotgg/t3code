import { requireOptionalNativeModule } from "expo";
import { useEffect, useSyncExternalStore } from "react";
import { Platform } from "react-native";

const nativeControls = requireOptionalNativeModule<{
  releaseVideoAudioSession(): Promise<void>;
}>("T3NativeControls");

// Players report not playing during seeks and buffering stalls, and another
// player may start right after one stops. Both keep the session.
const RELEASE_DELAY_MS = 1_000;

let playingCount = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

/** Pairs with `mediaPlaybackStopped` for each inline video or audio player holding the session. */
export function mediaPlaybackStarted(): void {
  playingCount += 1;
}

/**
 * expo-video activates the iOS playback session but never deactivates it, so
 * interrupted apps (Spotify, Podcasts) are never told they may resume. The
 * last player to stop releases it. In-app audio previews count too, since
 * deactivating stops them.
 */
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

/** Pairs with `fullscreenVideoClosed` while the native fullscreen player is open. */
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

/** In-app players pause while the iOS fullscreen player owns playback and the session. */
export function useFullscreenVideoOpen(): boolean {
  return useSyncExternalStore(subscribeFullscreenVideo, isFullscreenVideoOpen);
}

/** Holds the session for as long as `active`, releasing it with the last holder. */
export function useMediaAudioSessionHold(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    mediaPlaybackStarted();
    return () => mediaPlaybackStopped();
  }, [active]);
}
