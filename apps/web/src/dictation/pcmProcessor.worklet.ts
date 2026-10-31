// A separate worklet file satisfies desktop script-src 'self', which rejects blob modules.

const LEVELS_PER_SECOND = 25;
// Levels map -60 dBFS (quiet room) to 0 and full scale to 1, which tracks loudness as heard.
const LEVEL_FLOOR_DB = -60;
// Rises quickly with speech and falls back gently, so the level does not flicker between words.
const LEVEL_ATTACK = 0.6;
const LEVEL_RELEASE = 0.2;

// TypeScript's DOM lib does not describe the AudioWorkletGlobalScope.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new (options: {
    readonly processorOptions: { readonly targetRate: number; readonly frameSamples: number };
  }) => AudioWorkletProcessor,
): void;

class DictationPcmProcessor extends AudioWorkletProcessor {
  private readonly step: number;
  private readonly frameSamples: number;
  private readonly frame: DataView<ArrayBuffer>;
  private filled = 0;
  private sum = 0;
  private count = 0;
  private position = 0;
  private readonly levelWindow = Math.max(1, Math.round(sampleRate / LEVELS_PER_SECOND));
  private squares = 0;
  private levelSamples = 0;
  private level = 0;

  constructor(options: {
    readonly processorOptions: { readonly targetRate: number; readonly frameSamples: number };
  }) {
    super();
    this.step = sampleRate / options.processorOptions.targetRate;
    this.frameSamples = options.processorOptions.frameSamples;
    this.frame = new DataView(new ArrayBuffer(this.frameSamples * 2));
    this.port.addEventListener("message", () => {
      if (this.filled > 0) this.post();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A worklet port has no origin.
      this.port.postMessage("flushed");
    });
    this.port.start();
  }

  private post() {
    const buffer = this.frame.buffer.slice(0, this.filled * 2);
    this.filled = 0;
    this.port.postMessage(buffer, [buffer]);
  }

  private measure(value: number) {
    this.squares += value * value;
    this.levelSamples += 1;
    if (this.levelSamples < this.levelWindow) return;
    const rms = Math.sqrt(this.squares / this.levelSamples);
    this.squares = 0;
    this.levelSamples = 0;
    const db = rms > 0 ? 20 * Math.log10(rms) : LEVEL_FLOOR_DB;
    const target = Math.max(0, Math.min(1, 1 - db / LEVEL_FLOOR_DB));
    this.level += (target - this.level) * (target > this.level ? LEVEL_ATTACK : LEVEL_RELEASE);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A worklet port has no origin.
    this.port.postMessage(this.level);
  }

  process(inputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean {
    const channels = inputs[0] ?? [];
    const length = channels[0]?.length ?? 0;
    for (let index = 0; index < length; index++) {
      let value = 0;
      for (const channel of channels) value += channel[index] ?? 0;
      value /= channels.length;
      this.measure(value);
      this.sum += value;
      this.count += 1;
      this.position += 1;
      if (this.position < this.step) continue;
      const sample = Math.max(-1, Math.min(1, this.sum / this.count));
      const pcm = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.sum = 0;
      this.count = 0;
      while (this.position >= this.step) {
        this.position -= this.step;
        this.frame.setInt16(this.filled * 2, pcm, true);
        this.filled += 1;
        if (this.filled === this.frameSamples) this.post();
      }
    }
    return true;
  }
}

// Must match PROCESSOR_NAME in pcmCapture.ts.
registerProcessor("t3-dictation-pcm", DictationPcmProcessor);

// oxlint-disable-next-line unicorn/require-module-specifiers -- Keeps the worklet scope declarations above out of the app's globals.
export {};
