import {
  READ_ALOUD_LEVEL_INTERVAL_MS,
  readAloudLevel,
  smoothReadAloudLevel,
} from "@t3tools/shared/read-aloud";

const SAMPLES = 1024;

type CapturableAudio = HTMLAudioElement & { captureStream?: () => MediaStream };

/** Whether `audio`'s output can be captured to measure; Safari's cannot. */
export const canCapturePlayback = (audio: HTMLAudioElement) =>
  typeof (audio as CapturableAudio).captureStream === "function";

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
    level = smoothReadAloudLevel(level, readAloudLevel(energy / samples.length));
    listener(level);
  };
  const timer = setInterval(tick, READ_ALOUD_LEVEL_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    source?.disconnect();
    void context?.close();
  };
}
