const sources = {
  start: new URL("../../../../assets/voice-input/start.wav", import.meta.url).href,
  stop: new URL("../../../../assets/voice-input/stop.wav", import.meta.url).href,
};

export async function playVoiceInputCue(cue: "start" | "stop"): Promise<void> {
  const audio = new Audio(sources[cue]);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  audio.onended = () => finish();
  audio.onerror = () => finish();
  const timeout = setTimeout(finish, 1_500);
  try {
    void audio.play().catch(() => finish());
    await done;
  } finally {
    clearTimeout(timeout);
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
}
