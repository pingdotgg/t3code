import { useReleasingSharedObjectWithLifecycle } from "expo";
import { createAudioPlayer } from "expo-audio";
import { disposeAudioPlayer } from "../../lib/audioSession";

export function usePlaybackAudioPlayer(uri: string | null) {
  // Keep the native ref alive until any pending activation and release finish.
  return useReleasingSharedObjectWithLifecycle(
    {
      factory: () => createAudioPlayer(uri, { updateInterval: 500 }),
      release: disposeAudioPlayer,
    },
    [uri],
  );
}
