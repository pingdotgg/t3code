import type {
  PreparedVoiceTranscription,
  VoiceRecorder,
  VoiceStreamingSession,
  VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import { requestMicrophone } from "./requestMicrophone";
import workletUrl from "./pcmWorklet.ts?worker&url";

type PreparedBrowserTranscription = PreparedVoiceTranscription & {
  readonly streaming?: VoiceStreamingSession & { readonly feed: (pcm: Float32Array) => void };
};

export function createBrowserPcmCapture(
  input: {
    readonly getMicrophoneId: () => string;
    readonly onLevel: (level: number) => void;
    readonly onDurationLimit: () => void;
    readonly onError: (message: string) => void;
  },
  prepare: (options: VoiceTranscriptionOptions) => Promise<PreparedBrowserTranscription>,
) {
  let stream: MediaStream | undefined;
  let recordingUri: string | null = null;
  let chunks: Float32Array<ArrayBuffer>[] = [];
  let audioContext: AudioContext | undefined;
  let worklet: AudioWorkletNode | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let signal: AbortSignal | undefined;
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
    feed = undefined;
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
          if (feed) feed(data);
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
        () => stopped?.reject(new Error("Microphone capture did not stop.")),
        5_000,
      );
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      worklet.port.postMessage("stop");
      try {
        await pending;
        if (!feed && chunks.length) {
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
      prepare: async (options: VoiceTranscriptionOptions) => {
        const prepared = await prepare(options);
        options.signal.throwIfAborted();
        signal = options.signal;
        feed = prepared.streaming?.feed;
        return prepared;
      },
    },
  };
}
