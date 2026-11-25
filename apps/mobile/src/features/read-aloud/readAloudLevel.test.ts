import { expect, it } from "vite-plus/test";
import { audioSampleLevel, throttleAudioLevels } from "./readAloudLevel";

const tone = (amplitude: number) => ({
  frames: Array.from({ length: 64 }, (_, index) => (index % 2 ? amplitude : -amplitude)),
});

it("scales a buffer's RMS loudness from silence to full", () => {
  expect(audioSampleLevel([])).toBe(0);
  expect(audioSampleLevel([tone(0)])).toBe(0);
  expect(audioSampleLevel([tone(0.001)])).toBe(0);
  // -30 dB, halfway between the silence floor and the peak.
  expect(audioSampleLevel([tone(10 ** (-30 / 20))])).toBeCloseTo(0.5);
  expect(audioSampleLevel([tone(1)])).toBe(1);
  // Both channels count: a silent one halves the power, 3 dB down.
  expect(audioSampleLevel([tone(1), tone(0)])).toBeCloseTo(1);
  expect(audioSampleLevel([tone(0.1), tone(0)])).toBeCloseTo(0.6747, 3);
});

it("reports at most fifteen levels a second", () => {
  let time = 0;
  const levels: number[] = [];
  const report = throttleAudioLevels(
    (level) => levels.push(level),
    () => time,
  );
  for (; time < 1000; time += 10) report({ channels: [tone(1)] });
  expect(levels).toHaveLength(15);
});
