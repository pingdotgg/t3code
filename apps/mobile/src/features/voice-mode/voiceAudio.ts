import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

let owner: ReturnType<typeof acquireAudioSession> | null = null;

export async function setVoiceAudioActive(
  active: boolean,
  onCancel?: (error?: unknown) => void,
): Promise<void> {
  if (active) {
    owner ??= acquireAudioSession("recording", onCancel);
    const current = owner;
    try {
      await activateAudioSession(current);
    } catch (error) {
      if (owner === current) {
        owner = null;
        const release = releaseAudioSession(current);
        onCancel?.(error);
        await release.catch(() => undefined);
      }
      throw error;
    }
  } else {
    const previous = owner;
    owner = null;
    if (previous) await releaseAudioSession(previous);
  }
}
