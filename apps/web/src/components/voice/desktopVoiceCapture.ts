import captureWorkletUrl from "./dictationCapture.worklet.js?url&no-inline";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  type VoiceRecorder,
} from "@t3tools/client-runtime/voice-input";
import { randomUUID } from "~/lib/utils";

export function encodeDictationWav(
  chunks: readonly Float32Array[],
  sampleRate: number,
): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const input = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.length;
  }
  const count = Math.min(
    Math.floor((length * 16000) / sampleRate),
    16000 * VOICE_RECORDING_LIMIT_SECONDS,
  );
  const result = new Uint8Array(44 + count * 2);
  const view = new DataView(result.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) result[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, result.length - 8, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const index = (i * sampleRate) / 16000;
    const a = Math.floor(index);
    const value =
      (input[a] ?? 0) * (1 - (index - a)) + (input[a + 1] ?? input[a] ?? 0) * (index - a);
    const clamped = Math.max(-1, Math.min(1, value));
    view.setInt16(44 + i * 2, clamped * (clamped < 0 ? 32768 : 32767), true);
  }
  return result;
}
export class DesktopVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private rate = 16000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onStopped: (() => void) | null = null;
  private cancelled = false;
  private readonly microphone: () => string;
  private readonly ended: (error: string | null) => void;
  private readonly onTrackEnded = () =>
    this.ended("The microphone was disconnected. Select an available microphone and try again.");
  private readonly onProcessorError = () =>
    this.ended("The microphone audio processor failed. Cancel and try again.");
  private readonly onMessage = ({ data }: MessageEvent<unknown>) => {
    if (data === "stopped") this.onStopped?.();
    else if (data instanceof Float32Array) this.chunks.push(data);
  };
  constructor(microphone: () => string, ended: (error: string | null) => void) {
    this.microphone = microphone;
    this.ended = ended;
  }
  async prepareToRecordAsync() {
    this.cancelled = false;
    this.chunks = [];
    this.uri = `dictation:${randomUUID()}`;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(this.microphone() ? { deviceId: { exact: this.microphone() } } : {}),
        channelCount: 1,
        echoCancellation: true,
      },
      video: false,
    });
    if (this.cancelled) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Cancelled");
    }
    this.stream = stream;
    for (const track of stream.getAudioTracks()) track.addEventListener("ended", this.onTrackEnded);
    this.context = new AudioContext({ sampleRate: 16000 });
    this.rate = this.context.sampleRate;
    if (!this.context.audioWorklet) throw new Error("AudioWorklet is unavailable on this desktop.");
    // Packaged Electron permits same-origin scripts. A Blob worklet would violate
    // its script-src policy even though ordinary workers may use Blob URLs.
    await this.context.audioWorklet.addModule(captureWorkletUrl);
  }
  record({ forDuration }: { forDuration: number }) {
    if (!this.context || !this.stream || this.cancelled)
      throw new Error("No microphone is available.");
    this.node = new AudioWorkletNode(this.context, "t3-dictation-capture");
    this.node.addEventListener("processorerror", this.onProcessorError);
    this.node.port.addEventListener("message", this.onMessage);
    this.node.port.start();
    const source = this.context.createMediaStreamSource(this.stream);
    const muted = this.context.createGain();
    muted.gain.value = 0;
    source.connect(this.node);
    this.node.connect(muted);
    muted.connect(this.context.destination);
    void this.context
      .resume()
      .catch(() => this.ended("Could not activate the microphone audio session."));
    this.timer = setTimeout(() => {
      void this.stop().then(() => this.ended(null));
    }, forDuration * 1000);
  }
  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.node && this.context?.state === "running")
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        this.onStopped = () => {
          clearTimeout(timer);
          resolve();
        };
        // This is a dedicated AudioWorklet MessagePort, not a window message.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        this.node!.port.postMessage("stop");
      });
    await this.release();
  }
  async release() {
    this.cancelled = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.onStopped?.();
    this.onStopped = null;
    for (const track of this.stream?.getTracks() ?? []) {
      track.removeEventListener("ended", this.onTrackEnded);
      track.stop();
    }
    this.stream = null;
    this.node?.removeEventListener("processorerror", this.onProcessorError);
    this.node?.port.removeEventListener("message", this.onMessage);
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close();
  }
  audio() {
    return encodeDictationWav(this.chunks, this.rate);
  }
  clear() {
    this.chunks = [];
    this.uri = null;
  }
}
