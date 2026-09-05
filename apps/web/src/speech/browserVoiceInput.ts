import {
  throwIfVoiceTranscriptionAborted,
  transcribeEnvironmentPcm,
  VoiceTranscriptionError,
  type VoiceRecorder,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

import { runtime } from "../lib/runtime";

const TARGET_SAMPLE_RATE = 16_000;

function transcriptionError(cause: unknown) {
  return cause instanceof VoiceTranscriptionError
    ? cause
    : new VoiceTranscriptionError(
        "transcription-failed",
        "Voice transcription on this environment failed.",
        { cause },
      );
}

async function decodePcm(uri: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(uri, { signal });
  const encoded = await response.arrayBuffer();
  throwIfVoiceTranscriptionAborted(signal);
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(encoded);
    const length = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
    const offline = new OfflineAudioContext(1, length, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    throwIfVoiceTranscriptionAborted(signal);
    const samples = rendered.getChannelData(0);
    return new Uint8Array(
      samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
    );
  } finally {
    await context.close();
  }
}

export function createBrowserVoiceInputPlatform(input: {
  readonly prepared: PreparedConnection;
  readonly getMicrophoneId: () => string;
  readonly onLevel: (level: number) => void;
  readonly onDurationLimit: () => void;
}): {
  readonly recorder: VoiceRecorder;
  readonly transcriber: VoiceTranscriber;
  readonly cancelRecording: () => void;
  readonly deleteRecording: (uri: string) => void;
} {
  let stream: MediaStream | undefined;
  let mediaRecorder: MediaRecorder | undefined;
  let recordingUri: string | null = null;
  let chunks: Blob[] = [];
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let levelTimer: ReturnType<typeof setInterval> | undefined;
  let audioContext: AudioContext | undefined;

  const cleanupCapture = () => {
    if (durationTimer) clearTimeout(durationTimer);
    if (levelTimer) clearInterval(levelTimer);
    durationTimer = undefined;
    levelTimer = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    void audioContext?.close();
    audioContext = undefined;
    input.onLevel(0);
  };

  const recorder: VoiceRecorder = {
    get uri() {
      return recordingUri;
    },
    prepareToRecordAsync: async () => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("This browser cannot record microphone audio.");
      }
      if (recordingUri) URL.revokeObjectURL(recordingUri);
      recordingUri = null;
      chunks = [];
      const microphoneId = input.getMicrophoneId();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
      });
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });

      audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const levels = new Uint8Array(analyser.fftSize);
      levelTimer = setInterval(() => {
        analyser.getByteTimeDomainData(levels);
        let energy = 0;
        for (const value of levels) energy += ((value - 128) / 128) ** 2;
        input.onLevel(Math.min(1, Math.sqrt(energy / levels.length) * 4));
      }, 100);
    },
    record: ({ forDuration }) => {
      mediaRecorder?.start();
      durationTimer = setTimeout(input.onDurationLimit, forDuration * 1_000);
    },
    stop: async () => {
      const activeRecorder = mediaRecorder;
      if (!activeRecorder || activeRecorder.state === "inactive") return;
      await new Promise<void>((resolve, reject) => {
        activeRecorder.addEventListener("stop", () => resolve(), { once: true });
        activeRecorder.addEventListener("error", () => reject(activeRecorder.error), {
          once: true,
        });
        activeRecorder.stop();
      });
      const blob = new Blob(chunks, { type: activeRecorder.mimeType });
      cleanupCapture();
      mediaRecorder = undefined;
      chunks = [];
      if (blob.size === 0) throw new Error("No microphone audio was captured.");
      recordingUri = URL.createObjectURL(blob);
    },
  };

  return {
    recorder,
    cancelRecording: () => {
      if (mediaRecorder?.state !== "inactive") mediaRecorder?.stop();
      mediaRecorder = undefined;
      chunks = [];
      cleanupCapture();
    },
    deleteRecording: (uri) => {
      URL.revokeObjectURL(uri);
      if (recordingUri === uri) recordingUri = null;
    },
    transcriber: {
      prepare: async ({ signal }) => {
        throwIfVoiceTranscriptionAborted(signal);
        return {
          locale: "en",
          transcribe: async (uri, options) => {
            try {
              const pcm = await decodePcm(uri, options.signal);
              const result = await runtime.runPromise(
                transcribeEnvironmentPcm(input.prepared, pcm),
                { signal: options.signal },
              );
              throwIfVoiceTranscriptionAborted(options.signal);
              return result.text;
            } catch (error) {
              throwIfVoiceTranscriptionAborted(options.signal);
              throw transcriptionError(error);
            }
          },
        };
      },
    },
  };
}
