const sources = {
  start: new URL("../../../../assets/voice-input/start.wav", import.meta.url).href,
  stop: new URL("../../../../assets/voice-input/stop.wav", import.meta.url).href,
};

export async function playVoiceInputCue(cue: "start" | "stop"): Promise<void> {
  const audio = new Audio(sources[cue]);
  try {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(finish, 1_500);
      function finish() {
        clearTimeout(timeout);
        audio.onended = null;
        audio.onerror = null;
        resolve();
      }
      audio.onended = finish;
      audio.onerror = finish;
      void audio.play().catch(finish);
    });
  } finally {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
}
