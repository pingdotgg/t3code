import { DICTATION_SAMPLE_RATE } from "@t3tools/contracts";

import processorUrl from "./pcmProcessor.worklet.ts?worker&url";

// Must match the name pcmProcessor.worklet.ts registers.
const PROCESSOR_NAME = "t3-dictation-pcm";
const FRAME_SAMPLES = DICTATION_SAMPLE_RATE / 10;
const FLUSH_TIMEOUT_MS = 300;

function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : null;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was denied. Allow it in your browser or system settings, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "The microphone is in use by another app.";
  }
  return "Could not open the microphone.";
}

export type MicrophoneAccess =
  | { readonly granted: true }
  | { readonly granted: false; readonly message: string };

// Open synchronously from the user gesture so the browser permits the AudioContext.
export class PcmCapture {
  private generation = 0;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private flushed: (() => void) | null = null;
  /** The worklet module, loading while the microphone permission resolves. */
  private moduleLoaded: Promise<void> | null = null;

  async open(): Promise<MicrophoneAccess> {
    this.release();
    const generation = this.generation;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
      return {
        granted: false,
        message: "This page cannot use the microphone. Open T3 Code over HTTPS or localhost.",
      };
    }
    this.context = new AudioContext();
    // Load the worklet alongside the microphone request: audio that arrives
    // before the worklet is connected is lost, so this keeps the first word.
    const moduleLoaded = this.context.audioWorklet.addModule(processorUrl);
    moduleLoaded.catch(() => undefined);
    this.moduleLoaded = moduleLoaded;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      if (generation === this.generation) this.release();
      return { granted: false, message: microphoneErrorMessage(error) };
    }
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return { granted: false, message: "Voice input was cancelled." };
    }
    this.stream = stream;
    return { granted: true };
  }

  async prepare(): Promise<void> {
    const { context, stream, moduleLoaded } = this;
    if (!context || !stream || !moduleLoaded) throw new Error("The microphone is not open.");
    const generation = this.generation;
    await moduleLoaded;
    // Not awaited: without user activation (a synthetic key event, say) resume
    // never settles, and waiting on it would hold dictation in "preparing" forever.
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    if (generation !== this.generation) throw new Error("Voice input was cancelled.");
    this.source = context.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { targetRate: DICTATION_SAMPLE_RATE, frameSamples: FRAME_SAMPLES },
    });
  }

  /**
   * Delivers each frame's little-endian int16 bytes, in order, and the smoothed
   * 0..1 input level about 25 times a second, on the main thread.
   */
  start(onFrame: (frame: ArrayBuffer) => void, onLevel: (level: number) => void): void {
    const { node, source } = this;
    if (!node || !source) throw new Error("The microphone is not prepared.");
    node.port.addEventListener(
      "message",
      (event: MessageEvent<ArrayBuffer | number | "flushed">) => {
        if (event.data === "flushed") this.flushed?.();
        else if (typeof event.data === "number") onLevel(event.data);
        else onFrame(event.data);
      },
    );
    node.port.start();
    source.connect(node);
  }

  /** Stops listening and waits for the partial last frame, then releases everything. */
  async stop(): Promise<void> {
    const node = this.node;
    if (node) {
      this.source?.disconnect();
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        this.flushed = () => {
          clearTimeout(timeout);
          resolve();
        };
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A worklet port has no origin.
        node.port.postMessage("flush");
      });
    }
    this.release();
  }

  release(): void {
    this.generation += 1;
    this.flushed = null;
    if (this.node) {
      this.node.port.close();
      this.node.disconnect();
    }
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    const context = this.context;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
    this.node = null;
    this.source = null;
    this.stream = null;
    this.context = null;
    this.moduleLoaded = null;
  }
}
