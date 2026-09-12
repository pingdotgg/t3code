import { PcmResampler } from "./pcmResampler";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new PcmResampler(sampleRate);
  private chunk = new Float32Array(3_200);
  private length = 0;
  private recording = false;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data === "start") this.recording = true;
      if (data === "stop") {
        this.recording = false;
        this.append(this.resampler.flush());
        if (this.length) this.publish();
        this.port.postMessage("stopped");
      }
    };
  }

  private publish() {
    const pcm = this.chunk.slice(0, this.length);
    this.port.postMessage(pcm, [pcm.buffer]);
    this.length = 0;
  }

  private append(pcm: Float32Array) {
    for (const sample of pcm) {
      this.chunk[this.length++] = sample;
      if (this.length === this.chunk.length) this.publish();
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.recording) return true;
    const channels = inputs[0];
    if (!channels?.[0]) return true;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels)
      for (let i = 0; i < mono.length; i++) mono[i]! += channel[i]! / channels.length;
    this.append(this.resampler.push(mono));
    return true;
  }
}

registerProcessor("t3-pcm-capture", PcmCaptureProcessor);
