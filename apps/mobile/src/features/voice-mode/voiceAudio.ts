import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

let owner: ReturnType<typeof acquireAudioSession> | null = null;

export async function setVoiceAudioActive(active: boolean, onCancel?: () => void): Promise<void> {
  if (active) {
    owner ??= acquireAudioSession("recording", onCancel);
    await activateAudioSession(owner);
  } else {
    const previous = owner;
    owner = null;
    if (previous) await releaseAudioSession(previous);
  }
}
