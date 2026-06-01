import { getPreferredAudioRecordingOptions } from "./audioTranscription";

export interface BrowserAudioRecorder {
  readonly start: () => void;
  readonly stop: () => Promise<Blob>;
  readonly cancel: () => void;
}

type AudioContextConstructor = typeof AudioContext;

interface WindowWithWebkitAudioContext extends Window {
  readonly webkitAudioContext?: AudioContextConstructor;
}

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const browserWindow = window as WindowWithWebkitAudioContext;
  const NativeAudioContext = typeof AudioContext === "undefined" ? undefined : AudioContext;
  return NativeAudioContext ?? browserWindow.webkitAudioContext ?? null;
}

export function isAudioRecordingSupported(): boolean {
  return getAudioRecordingUnavailableReason() === null;
}

export function getAudioRecordingUnavailableReason(): string | null {
  if (typeof navigator === "undefined") {
    return "Voice recording is unavailable in this environment.";
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Browser microphone access requires HTTPS, localhost, or the desktop app.";
  }
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
    return "This browser does not expose microphone capture on the current page.";
  }
  if (typeof MediaRecorder === "undefined" && getAudioContextConstructor() === null) {
    return "This browser does not expose a compatible microphone recorder.";
  }
  return null;
}

export async function createAudioRecorder(stream: MediaStream): Promise<BrowserAudioRecorder> {
  if (typeof MediaRecorder !== "undefined") {
    return createMediaRecorder(stream);
  }

  const AudioContextClass = getAudioContextConstructor();
  if (AudioContextClass) {
    return createWavAudioRecorder(stream, AudioContextClass);
  }

  throw new Error("This browser does not expose a compatible microphone recorder.");
}

function createMediaRecorder(stream: MediaStream): BrowserAudioRecorder {
  const recorder = new MediaRecorder(stream, getPreferredAudioRecordingOptions());
  const chunks: Blob[] = [];
  let stopPromise: Promise<Blob> | null = null;

  const handleDataAvailable = (event: BlobEvent) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  recorder.addEventListener("dataavailable", handleDataAvailable);

  const cleanup = () => {
    recorder.removeEventListener("dataavailable", handleDataAvailable);
  };

  return {
    start: () => {
      recorder.start();
    },
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }

      stopPromise = new Promise<Blob>((resolve, reject) => {
        const handleStop = () => {
          cleanup();
          const mimeType = recorder.mimeType || getPreferredAudioRecordingOptions()?.mimeType || "";
          resolve(new Blob(chunks, { type: mimeType }));
        };
        const handleError = () => {
          cleanup();
          reject(new Error("The browser could not continue recording from the microphone."));
        };

        recorder.addEventListener("stop", handleStop, { once: true });
        recorder.addEventListener("error", handleError, { once: true });
        recorder.stop();
      });

      return stopPromise;
    },
    cancel: () => {
      cleanup();
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    },
  };
}

async function createWavAudioRecorder(
  stream: MediaStream,
  AudioContextClass: AudioContextConstructor,
): Promise<BrowserAudioRecorder> {
  const audioContext = new AudioContextClass();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const buffers: Float32Array[] = [];
  let stopped = false;

  processor.onaudioprocess = (event) => {
    if (stopped) {
      return;
    }
    const input = event.inputBuffer.getChannelData(0);
    buffers.push(new Float32Array(input));
  };

  const cleanup = () => {
    stopped = true;
    processor.disconnect();
    source.disconnect();
  };

  return {
    start: () => {
      source.connect(processor);
      processor.connect(audioContext.destination);
      if (audioContext.state === "suspended") {
        void audioContext.resume();
      }
    },
    stop: async () => {
      cleanup();
      await audioContext.close();
      return encodeWavBlob(buffers, audioContext.sampleRate);
    },
    cancel: () => {
      cleanup();
      void audioContext.close();
    },
  };
}

function encodeWavBlob(buffers: ReadonlyArray<Float32Array>, sampleRate: number): Blob {
  const samples = mergeBuffers(buffers);
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([view], { type: "audio/wav" });
}

function mergeBuffers(buffers: ReadonlyArray<Float32Array>): Float32Array {
  const sampleCount = buffers.reduce((total, buffer) => total + buffer.length, 0);
  const samples = new Float32Array(sampleCount);
  let offset = 0;
  for (const buffer of buffers) {
    samples.set(buffer, offset);
    offset += buffer.length;
  }
  return samples;
}

function writeString(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
