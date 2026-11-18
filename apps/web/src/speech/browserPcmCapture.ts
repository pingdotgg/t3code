import type {
  PreparedVoiceTranscription,
  VoiceRecorder,
  VoiceStreamingSession,
  VoiceInputErrorCode,
  VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import { requestMicrophone } from "./requestMicrophone";
import workletUrl from "./pcmWorklet.ts?worker&url";
import { msg } from "gt-react";
import { m } from "../i18n/messages";

type PreparedBrowserTranscription = PreparedVoiceTranscription & {
  readonly streaming?: VoiceStreamingSession & { readonly feed: (pcm: Float32Array) => void };
};

type OpenedCapture = { readonly stream: MediaStream; readonly context: AudioContext };

// lib.dom does not type AudioContext sink selection yet. Browsers without it ignore the option.
const withoutOutputDevice: AudioContextOptions & { readonly sinkId: { readonly type: "none" } } = {
  sinkId: { type: "none" },
};

/** Opens the microphone and its context; both are released on abort until the recorder claims them. */
function openCapture(getMicrophoneId: () => string | Promise<string>, signal: AbortSignal) {
  signal.throwIfAborted();
  const owner = new AbortController();
  const follow = () => owner.abort(signal.reason);
  signal.addEventListener("abort", follow, { once: true });
  const captureSignal = owner.signal;
  let context: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let released = false;
  const release = () => {
    stream?.getTracks().forEach((track) => track.stop());
    if (released) return;
    released = true;
    void context?.close();
  };
  captureSignal.addEventListener("abort", release, { once: true });
  const opened = (async (): Promise<OpenedCapture> => {
    // Capture plays nothing. On devices that share input and output, an output device or a
    // context created just after the microphone opens can each stall startup by ~450 ms.
    const openedContext = new AudioContext(withoutOutputDevice);
    context = openedContext;
    // Insecure origins have no audioWorklet; the rejection must reach release below.
    const loadingWorklet = Promise.resolve().then(() =>
      openedContext.audioWorklet.addModule(workletUrl),
    );
    loadingWorklet.catch(() => undefined);
    const microphoneId = await getMicrophoneId();
    captureSignal.throwIfAborted();
    stream = await requestMicrophone(microphoneId, captureSignal);
    captureSignal.throwIfAborted();
    await loadingWorklet;
    captureSignal.throwIfAborted();
    return { stream, context: openedContext };
  })();
  opened.catch(release);
  return {
    opened,
    claim: () => captureSignal.removeEventListener("abort", release),
    abandon: () => owner.abort(),
  };
}

export function createBrowserPcmCapture(
  input: {
    readonly getMicrophoneId: () => string | Promise<string>;
    readonly onLevel: (level: number) => void;
    readonly onDurationLimit: () => void;
    readonly onError: (message: string, code?: VoiceInputErrorCode) => void;
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
  let opening: ReturnType<typeof openCapture> | undefined;
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
      const capture = opening;
      opening = undefined;
      if (!captureSignal || !capture)
        throw new Error(m(msg("Voice transcription is not prepared.")));
      captureSignal.throwIfAborted();
      if (recordingUri) URL.revokeObjectURL(recordingUri);
      recordingUri = null;
      chunks = [];
      const { stream: captured, context } = await new Promise<OpenedCapture>((resolve, reject) => {
        const onAbort = () => reject(captureSignal.reason);
        captureSignal.addEventListener("abort", onAbort, { once: true });
        void capture.opened.then(
          (opened) => {
            captureSignal.removeEventListener("abort", onAbort);
            if (captureSignal.aborted) return;
            capture.claim();
            resolve(opened);
          },
          (error: unknown) => {
            captureSignal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
      stream = captured;
      audioContext = context;
      try {
        captureSignal.throwIfAborted();
        if (!captured.getTracks().some((track) => track.readyState === "live")) {
          const message = m(msg("The microphone disconnected."));
          input.onError(message, "microphone-disconnected");
          throw new Error(message);
        }
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
        const capture = openCapture(input.getMicrophoneId, options.signal);
        try {
          const prepared = await prepare(options);
          options.signal.throwIfAborted();
          signal = options.signal;
          opening = capture;
          feed = prepared.streaming?.feed;
          return prepared;
        } catch (error) {
          capture.abandon();
          throw error;
        }
      },
    },
  };
}
