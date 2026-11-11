import { AudioModule, setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";

type AudioSessionToken = {
  readonly kind: "playback" | "recording";
  readonly onCancel?: () => void;
  readonly onRelease?: () => void;
  released: boolean;
};

let owner: AudioSessionToken | null = null;
let pending = Promise.resolve();

// Native session calls are async. Finish an old activation before releasing it
// or configuring its successor, so it cannot reactivate a released session.
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(
    () => {},
    () => {},
  );
  return result;
}

export function pauseAudioPlayer(player: { pause(deactivateSession?: boolean): void }): void {
  // Expo Audio otherwise deactivates iOS's shared session 100 ms after pause,
  // even when a video or recorder has already taken ownership.
  if (owner && !owner.released) player.pause(false);
  else player.pause();
}

export function disposeAudioPlayer(player: {
  pause(deactivateSession?: boolean): void;
  release(): void;
}): void {
  void enqueue(async () => {
    try {
      pauseAudioPlayer(player);
    } finally {
      player.release();
    }
  }).catch(() => {});
}

export function acquireAudioSession(
  kind: AudioSessionToken["kind"],
  onCancel?: () => void,
  onRelease?: () => void,
) {
  const token: AudioSessionToken = { kind, onCancel, onRelease, released: false };
  if (kind === "playback" && owner?.kind === "recording" && !owner.released) return token;
  const previous = owner;
  // Publish before cancelling the old player, including callbacks already queued by Expo.
  AudioModule.setAudioSessionOwner?.(true);
  owner = token;
  if (previous && !previous.released) previous.onCancel?.();
  return token;
}

export function isAudioSessionOwner(token: AudioSessionToken): boolean {
  return owner === token && !token.released;
}

export function activateAudioSession(
  token: AudioSessionToken,
  nativePlayback = false,
): Promise<boolean> {
  return enqueue(async () => {
    if (!isAudioSessionOwner(token)) return false;
    // Video configures and activates its own native session, including moviePlayback on iOS.
    if (nativePlayback) return true;
    await setAudioModeAsync({
      allowsRecording: token.kind === "recording",
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    if (!isAudioSessionOwner(token)) return false;
    await setIsAudioActiveAsync(true);
    return isAudioSessionOwner(token);
  });
}

export function releaseAudioSession(token: AudioSessionToken): Promise<void> {
  token.released = true;
  return enqueue(async () => {
    if (owner !== token) return;
    try {
      if (token.kind === "recording") await setAudioModeAsync({ allowsRecording: false });
    } finally {
      if (owner === token) {
        if (token.kind === "recording") await setIsAudioActiveAsync(false);
        // Expo pause releases the native session without disabling its global playback gate.
        // Repeat it after any pending activation, even if playback never started.
        token.onRelease?.();
        if (owner === token) {
          AudioModule.setAudioSessionOwner?.(false);
          owner = null;
        }
      }
    }
  });
}

export function createAudioPlaybackSession(
  player: { play(): void; pause(deactivateSession?: boolean): void },
  nativePlayback = false,
  onRequestedChange?: (requested: boolean) => void,
) {
  let token: AudioSessionToken | null = null;
  const stopPlayer = () => {
    // useAudioPlayer/useVideoPlayer may have disposed the native ref during unmount.
    try {
      if (nativePlayback) player.pause();
      else pauseAudioPlayer(player);
    } catch {}
  };
  const pause = () => {
    const previous = token;
    token = null;
    onRequestedChange?.(false);
    stopPlayer();
    if (previous) void releaseAudioSession(previous).catch(() => {});
  };
  const acquire = () => {
    const next = acquireAudioSession("playback", pause, stopPlayer);
    if (!isAudioSessionOwner(next)) {
      stopPlayer();
      return null;
    }
    token = next;
    onRequestedChange?.(true);
    return next;
  };
  return {
    pause,
    get requested() {
      return token !== null;
    },
    async play(prepare?: () => Promise<void>) {
      const current = token ?? acquire();
      if (!current) return;
      try {
        await prepare?.();
        if (!(await activateAudioSession(current, nativePlayback))) return;
        if (token !== current || !isAudioSessionOwner(current)) return;
        player.play();
      } catch (error) {
        if (token === current) pause();
        throw error;
      }
    },
    // A stopped clock is also reported during buffering and seeks. Native
    // pause intent must call pause() separately from playingChange.
    playingChanged(playing: boolean) {
      if (playing && token === null) acquire();
    },
  };
}
