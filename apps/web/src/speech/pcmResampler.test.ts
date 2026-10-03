import { expect, it } from "vite-plus/test";
import { PcmResampler } from "./pcmResampler";

it.each([16_000, 44_100, 48_000])("preserves sample phase across blocks at %i Hz", (rate) => {
  const input = Float32Array.from(
    { length: rate },
    (_, i) => Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5,
  );
  const whole = new PcmResampler(rate).push(input);
  const resampler = new PcmResampler(rate);
  const parts: number[] = [];
  for (let i = 0; i < input.length; i += 128)
    parts.push(...resampler.push(input.subarray(i, i + 128)));
  expect(parts).toEqual([...whole]);
  expect(Math.abs(whole.length - 16_000)).toBeLessThanOrEqual(1);
  expect(whole.every(Number.isFinite)).toBe(true);
});

it("filters frequencies above the output Nyquist limit", () => {
  const convert = (frequency: number) => {
    const input = Float32Array.from({ length: 48_000 }, (_, i) =>
      Math.sin((2 * Math.PI * frequency * i) / 48_000),
    );
    const output = new PcmResampler(48_000).push(input).subarray(100);
    return Math.sqrt(output.reduce((sum, value) => sum + value * value, 0) / output.length);
  };
  expect(convert(1_000)).toBeGreaterThan(0.65);
  expect(convert(12_000)).toBeLessThan(0.01);
});

it("flushes the filter tail so a final partial capture is retained", () => {
  const resampler = new PcmResampler(48_000);
  const input = new Float32Array(128);
  input[127] = 1;
  resampler.push(input);
  const tail = resampler.flush();
  expect(tail.some((sample) => Math.abs(sample) > 0.1)).toBe(true);
});
