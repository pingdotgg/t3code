import {
  getEnvironmentSpeechStatus,
  getEnvironmentSpeechStreamUrl,
  openSpeechStream,
  throwIfVoiceTranscriptionAborted,
  transcribeEnvironmentPcm,
  VoiceTranscriptionError,
  type VoiceRecorder,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { SpeechStreamText } from "@t3tools/contracts";

import { runtime } from "../lib/runtime";
import workletUrl from "./pcmWorklet.ts?worker&url";

export function createBrowserVoiceInputPlatform(input: {
  readonly prepared: PreparedConnection;
  readonly getMicrophoneId: () => string;
  readonly onLevel: (level: number) => void;
  readonly onDurationLimit: () => void;
  readonly onText: (text: SpeechStreamText) => void;
  readonly onError: (message: string) => void;
}): {
  readonly recorder: VoiceRecorder;
  readonly transcriber: VoiceTranscriber;
  readonly cancelRecording: () => void;
  readonly deleteRecording: (uri: string) => void;
} {
  let stream: MediaStream | undefined;
  let recordingUri: string | null = null;
  let chunks: Float32Array<ArrayBuffer>[] = [];
  let audioContext: AudioContext | undefined;
  let worklet: AudioWorkletNode | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let signal: AbortSignal | undefined;
  let live: Awaited<ReturnType<typeof openSpeechStream>> | undefined;
  let stopped: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  const cleanupCapture = () => {
    if (durationTimer) clearTimeout(durationTimer);
    durationTimer = undefined;
    worklet?.disconnect();
    worklet?.port.close();
    worklet = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    void audioContext?.close();
    audioContext = undefined;
    stopped?.resolve();
    stopped = undefined;
    input.onLevel(0);
  };

  const recorder: VoiceRecorder = {
    get uri() {
      return recordingUri;
    },
    prepareToRecordAsync: async () => {
      const captureSignal = signal;
      if (!captureSignal) throw new Error("Voice transcription is not prepared.");
      captureSignal.throwIfAborted();
      if (recordingUri) URL.revokeObjectURL(recordingUri);
      recordingUri = null;
      chunks = [];
      const microphoneId = input.getMicrophoneId();
      const captured = await navigator.mediaDevices.getUserMedia({
        audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
      });
      if (captureSignal.aborted) {
        captured.getTracks().forEach((track) => track.stop());
        captureSignal.throwIfAborted();
      }
      stream = captured;
      try {
        const context = new AudioContext();
        audioContext = context;
        await context.audioWorklet.addModule(workletUrl);
        captureSignal.throwIfAborted();
        const node = new AudioWorkletNode(context, "t3-pcm-capture", { channelCount: 1 });
        worklet = node;
        node.port.onmessage = ({
          data,
        }: MessageEvent<Float32Array<ArrayBuffer> | "stopped" | "limit">) => {
          if (captureSignal.aborted) return;
          if (data === "stopped") {
            stopped?.resolve();
            return;
          }
          if (data === "limit") {
            input.onDurationLimit();
            return;
          }
          let energy = 0;
          for (const value of data) energy += value * value;
          input.onLevel(Math.min(1, Math.sqrt(energy / data.length) * 4));
          if (live) live.feed(data);
          else chunks.push(data);
        };
        node.onprocessorerror = () => {
          stopped?.reject(new Error("Microphone processing failed."));
          input.onError("Microphone processing failed.");
        };
        for (const track of captured.getTracks())
          track.addEventListener("ended", () => input.onError("The microphone disconnected."), {
            once: true,
          });
        context.createMediaStreamSource(captured).connect(node);
        // The processor emits silence, keeping the graph active without microphone playback.
        node.connect(context.destination);
        await context.resume();
        captureSignal.throwIfAborted();
      } catch (error) {
        cleanupCapture();
        throw error;
      }
    },
    record: ({ forDuration }) => {
      worklet?.port.postMessage("start");
      durationTimer = setTimeout(input.onDurationLimit, forDuration * 1_000);
    },
    stop: async () => {
      if (!worklet) return;
      if (signal?.aborted) {
        cleanupCapture();
        return;
      }
      stopped ??= Promise.withResolvers<void>();
      const pending = stopped.promise;
      const timeout = setTimeout(
        () => stopped?.reject(new Error("Microphone capture did not stop.")),
        5_000,
      );
      worklet.port.postMessage("stop");
      try {
        await pending;
        if (!live && chunks.length) {
          const blob = new Blob(chunks, { type: "application/octet-stream" });
          recordingUri = URL.createObjectURL(blob);
        }
      } finally {
        clearTimeout(timeout);
        chunks = [];
        cleanupCapture();
      }
    },
  };

  return {
    recorder,
    cancelRecording: cleanupCapture,
    deleteRecording: (uri) => {
      URL.revokeObjectURL(uri);
      if (recordingUri === uri) recordingUri = null;
    },
    transcriber: {
      prepare: async (options) => {
        signal = options.signal;
        live = undefined;
        const status = await runtime.runPromise(
          getEnvironmentSpeechStatus(input.prepared),
          options,
        );
        throwIfVoiceTranscriptionAborted(options.signal);
        if (!status.supported) throw new VoiceTranscriptionError("unavailable", status.reason);
        if (status.supportsStreaming) {
          const url = await runtime.runPromise(
            getEnvironmentSpeechStreamUrl(input.prepared),
            options,
          );
          live = await openSpeechStream({
            url,
            signal: options.signal,
            onText: input.onText,
            onError: (error) => input.onError(error.message),
          });
          const session = live;
          return { locale: "en", finish: () => session.finish() };
        }
        return {
          locale: "en",
          transcribe: async (uri, { signal: transcriptionSignal }) => {
            try {
              const response = await fetch(uri, { signal: transcriptionSignal });
              const pcm = new Uint8Array(await response.arrayBuffer());
              const result = await runtime.runPromise(
                transcribeEnvironmentPcm(input.prepared, pcm),
                { signal: transcriptionSignal },
              );
              throwIfVoiceTranscriptionAborted(transcriptionSignal);
              return result.text;
            } catch (cause) {
              throwIfVoiceTranscriptionAborted(transcriptionSignal);
              throw new VoiceTranscriptionError(
                "transcription-failed",
                "Voice transcription on this environment failed.",
                { cause },
              );
            }
          },
        };
      },
    },
  };
}
