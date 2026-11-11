const TARGET_RATE = 16_000;

/** Low-pass before downsampling, preserving filter and sample phase across capture blocks. */
export class PcmResampler {
  private readonly coefficients: Float64Array;
  private readonly history: Float32Array;
  private position = 0;
  private phase = 0;
  private readonly ratio: number;

  constructor(sampleRate: number) {
    if (sampleRate < TARGET_RATE)
      throw new Error("Microphone sample rate must be at least 16 kHz.");
    this.ratio = sampleRate / TARGET_RATE;
    this.coefficients = new Float64Array(sampleRate === TARGET_RATE ? 1 : 63);
    this.history = new Float32Array(this.coefficients.length);
    const middle = (this.coefficients.length - 1) / 2;
    const cutoff = 7_200 / sampleRate;
    let sum = 0;
    for (let i = 0; i < this.coefficients.length; i++) {
      const x = i - middle;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = middle === 0 ? 1 : 0.54 - 0.46 * Math.cos((Math.PI * i) / middle);
      this.coefficients[i] = sinc * window;
      sum += this.coefficients[i]!;
    }
    for (let i = 0; i < this.coefficients.length; i++) this.coefficients[i]! /= sum;
  }

  push(samples: Float32Array): Float32Array {
    const output: number[] = [];
    for (const sample of samples) {
      this.history[this.position] = sample;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let value = 0;
        for (let tap = 0; tap < this.coefficients.length; tap++) {
          const index = (this.position - tap + this.history.length) % this.history.length;
          value += this.history[index]! * this.coefficients[tap]!;
        }
        output.push(Math.max(-1, Math.min(1, value)));
      }
      this.position = (this.position + 1) % this.history.length;
    }
    return Float32Array.from(output);
  }

  flush(): Float32Array {
    return this.coefficients.length === 1
      ? new Float32Array()
      : this.push(new Float32Array(this.history.length - 1));
  }
}
