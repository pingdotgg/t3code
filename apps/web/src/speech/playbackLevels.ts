// As often as dictation's meter and with its smoothing. Speech audio is mastered quieter than a
// close microphone, so it is scaled up more to fill the same waveform.
const LEVEL_INTERVAL_MS = 50;
const GAIN = 8;
const SAMPLES = 1024;
const ATTACK = Math.exp(-LEVEL_INTERVAL_MS / 75);
const RELEASE = Math.exp(-LEVEL_INTERVAL_MS / 200);

type CapturableAudio = HTMLAudioElement & { captureStream?: () => MediaStream };

/**
 * How loud `audio` plays, read from a captured copy of its output so playback never depends on
 * Web Audio. Browsers without `captureStream`, such as Safari, report nothing.
 */
export function playbackLevels(audio: HTMLAudioElement, listener: (level: number) => void) {
  const capture = (audio as CapturableAudio).captureStream;
  if (!capture) return () => {};
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let level = 0;
  const samples = new Float32Array(SAMPLES);
  const tick = () => {
    if (audio.paused) {
      if (level) listener((level = 0));
      return;
    }
    if (!analyser) {
      // A captured stream gets its audio track once the element plays.
      const stream = capture.call(audio);
      if (!stream.getAudioTracks().length) return;
      context = new AudioContext();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = SAMPLES;
      source.connect(analyser);
    }
    analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    const target = Math.min(1, Math.sqrt(energy / samples.length) * GAIN);
    level = target + (level - target) * (target > level ? ATTACK : RELEASE);
    listener(level);
  };
  const timer = setInterval(tick, LEVEL_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    source?.disconnect();
    void context?.close();
  };
}
