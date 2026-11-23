import {
  VoiceTranscriptionError,
  type PreparedVoiceTranscription,
  type VoiceRecorder,
  type VoiceStreamingSession,
  type VoiceInputErrorCode,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import * as Schema from "effect/Schema";
import { requestMicrophone } from "./requestMicrophone";
import workletUrl from "./pcmWorklet.ts?worker&url";
import { msg } from "gt-react";
import { m } from "../i18n/messages";

const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);

type PreparedBrowserTranscription = PreparedVoiceTranscription & {
  readonly streaming?: VoiceStreamingSession & { readonly feed: (pcm: Float32Array) => void };
};

export function createBrowserPcmCapture(
  input: {
    readonly getMicrophoneId: () => string | Promise<string>;
    readonly onLevel: (level: number) => void;
    readonly onDurationLimit: () => void;
    readonly onError: (message: string, code?: VoiceInputErrorCode) => void;
  },
  prepare: (
    options: VoiceTranscriptionOptions,
    canStream: () => boolean,
  ) => Promise<PreparedBrowserTranscription>,
) {
  let stream: MediaStream | undefined;
  let recordingUri: string | null = null;
  let chunks: Float32Array<ArrayBuffer>[] = [];
  let audioContext: AudioContext | undefined;
  let worklet: AudioWorkletNode | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let signal: AbortSignal | undefined;
  let stopAcceptingAudio: (() => void) | undefined;
  let feed: ((pcm: Float32Array) => void) | undefined;
  let stopped:
    | { readonly resolve: () => void; readonly reject: (error: Error) => void }
    | undefined;

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
    chunks = [];
    stopAcceptingAudio?.();
    stopAcceptingAudio = undefined;
    feed = undefined;
    input.onLevel(0);
  };

  const recorder: VoiceRecorder = {
    get uri() {
      return recordingUri;
    },
    prepareToRecordAsync: async () => {
      const captureSignal = signal;
      if (!captureSignal) throw new Error(m(msg("Voice transcription is not prepared.")));
      captureSignal.throwIfAborted();
      if (recordingUri) URL.revokeObjectURL(recordingUri);
      recordingUri = null;
      chunks = [];
      const microphoneId = await input.getMicrophoneId();
      captureSignal.throwIfAborted();
      const captured = await new Promise<MediaStream>((resolve, reject) => {
        const onAbort = () => reject(captureSignal.reason);
        const permission = requestMicrophone(microphoneId, captureSignal);
        captureSignal.addEventListener("abort", onAbort, { once: true });
        void permission.then(
          (media) => {
            captureSignal.removeEventListener("abort", onAbort);
            if (captureSignal.aborted) media.getTracks().forEach((track) => track.stop());
            else resolve(media);
          },
          (error: unknown) => {
            captureSignal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
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
        }: MessageEvent<Float32Array<ArrayBuffer> | number | "stopped" | "limit">) => {
          if (captureSignal.aborted) return;
          if (data === "stopped") {
            stopped?.resolve();
            return;
          }
          if (data === "limit") {
            input.onDurationLimit();
            return;
          }
          if (typeof data === "number") {
            input.onLevel(data);
            return;
          }
          // Kept even while streaming, so a dropped stream can still upload the recording.
          chunks.push(data);
          feed?.(data);
        };
        node.onprocessorerror = () => {
          stopped?.reject(new Error(m(msg("Microphone processing failed."))));
          input.onError(m(msg("Microphone processing failed.")), "microphone-failed");
        };
        for (const track of captured.getTracks())
          track.addEventListener(
            "ended",
            () => input.onError(m(msg("The microphone disconnected.")), "microphone-disconnected"),
            {
              once: true,
            },
          );
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
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      worklet?.port.postMessage("start");
      durationTimer = setTimeout(input.onDurationLimit, forDuration * 1_000);
    },
    stop: async () => {
      if (!worklet) return;
      if (signal?.aborted) {
        cleanupCapture();
        return;
      }
      const pending = new Promise<void>((resolve, reject) => {
        stopped = { resolve, reject };
      });
      const timeout = setTimeout(
        () => stopped?.reject(new Error(m(msg("Microphone capture did not stop.")))),
        5_000,
      );
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      worklet.port.postMessage("stop");
      try {
        await pending;
        if (chunks.length) {
          const blob = new Blob(chunks, { type: "application/octet-stream" });
          recordingUri = URL.createObjectURL(blob);
        }
      } finally {
        clearTimeout(timeout);
        cleanupCapture();
      }
    },
  };

  return {
    recorder,
    cancelRecording: cleanupCapture,
    deleteRecording: (uri: string) => {
      URL.revokeObjectURL(uri);
      if (recordingUri === uri) recordingUri = null;
    },
    transcriber: {
      prepare: async (options: VoiceTranscriptionOptions): Promise<PreparedVoiceTranscription> => {
        signal = options.signal;
        let acceptingAudio = true;
        stopAcceptingAudio = () => {
          acceptingAudio = false;
        };
        const canStream = () => acceptingAudio && !options.signal.aborted;
        let streaming: VoiceStreamingSession | undefined;
        let destination: PreparedBrowserTranscription | undefined;
        const pending = prepare(options, canStream)
          .then((prepared) => {
            options.signal.throwIfAborted();
            destination = prepared;
            if (canStream() && prepared.streaming) {
              streaming = prepared.streaming;
              feed = prepared.streaming.feed;
              for (const chunk of chunks) feed(chunk);
            }
            return prepared;
          })
          .catch((cause: unknown) => {
            const error = new VoiceTranscriptionError({
              code: "preparation-failed",
              message: isVoiceTranscriptionError(cause)
                ? cause.message
                : m(msg("Could not prepare voice transcription.")),
              cause,
            });
            if (canStream()) input.onError(error.message);
            throw error;
          });
        void pending.catch(() => {});
        return {
          get locale() {
            return destination?.locale ?? "auto";
          },
          // A destination drops `streaming` when its stream fails, so the recording uploads instead.
          get streaming() {
            return destination?.streaming ? streaming : undefined;
          },
          async transcribe(uri, transcriptionOptions) {
            const prepared = await pending;
            return prepared.transcribe(uri, transcriptionOptions);
          },
        };
      },
    },
  };
}
