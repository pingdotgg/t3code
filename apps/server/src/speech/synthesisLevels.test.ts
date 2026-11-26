import { expect, it } from "vite-plus/test";

import { streamingMp3Encoder } from "./synthesisAudio.ts";
import { powerLevel, speechLevels } from "./synthesisLevels.ts";

const RATE = 24_000;
// LAME delays its MP3 by 1,105 samples, so PCM levels start that much later.
const DELAY_SECONDS = 1105 / RATE;

/** A sine at `decibels` of mean-square power, or silence, for each of `sections`. */
function speech(sections: ReadonlyArray<{ readonly seconds: number; readonly decibels?: number }>) {
  const samples: number[] = [];
  for (const { seconds, decibels } of sections) {
    const amplitude = decibels === undefined ? 0 : Math.SQRT2 * 10 ** (decibels / 20);
    for (let index = 0; index < seconds * RATE; index++)
      samples.push(Math.round(amplitude * Math.sin((2 * Math.PI * 220 * index) / RATE) * 0x7fff));
  }
  return Int16Array.from(samples);
}

const mean = (values: ReadonlyArray<number>) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

it("maps mean-square power onto the meter's decibel scale", () => {
  expect([powerLevel(0), powerLevel(1e-6), powerLevel(1e-3), powerLevel(0.1)]).toEqual([
    0, 0, 0.5, 1,
  ]);
});

it("measures PCM per window where the MP3 encoded from it plays", () => {
  const levels = speechLevels();
  levels.pushPcm(speech([{ seconds: 0.5, decibels: -30 }]), RATE, 0);
  levels.pushPcm(speech([{ seconds: 0.5 }]), RATE, 0.5);
  // The window still filling waits for the audio's end.
  expect(levels.count).toBe(Math.floor((1 + DELAY_SECONDS) / 0.05));
  levels.finish();
  expect(levels.count).toBe(Math.ceil((1 + DELAY_SECONDS) / 0.05));
  const values = levels.slice(0);
  // -30 dB is half the meter, and the silence is empty.
  expect(values.slice(1, 10)).toEqual(Array(9).fill(10));
  expect(values.slice(12)).toEqual(Array(values.length - 12).fill(0));
  expect(levels.slice(18)).toEqual(values.slice(18));
});

it("prefers PCM over the MP3 encoded from it", () => {
  const levels = speechLevels();
  levels.pushMp3(Uint8Array.of(0xff, 0xfb, 0x50, 0xc4));
  levels.pushPcm(speech([{ seconds: 0.2, decibels: -10 }]), RATE, 0);
  levels.pushMp3(new Uint8Array(4096));
  levels.finish();
  expect(levels.slice(1).every((value) => value === 20)).toBe(true);
});

it("estimates MP3-only audio from its frames' global gains as chunks arrive", async () => {
  const encoder = await streamingMp3Encoder(RATE, 1);
  const pcm = speech([
    { seconds: 0.5 },
    { seconds: 1, decibels: -12 },
    { seconds: 0.5, decibels: -45 },
    { seconds: 0.5 },
  ]);
  const bytes = new Uint8Array(pcm.buffer);
  const levels = speechLevels();
  const chunks = [encoder.push(bytes).mp3, encoder.flush()];
  for (const chunk of chunks)
    for (let at = 0; at < chunk.length; at += 777) levels.pushMp3(chunk.subarray(at, at + 777));
  levels.finish();
  const values = levels.slice(0);
  expect(values.length).toBeGreaterThanOrEqual(50);
  // Windows well inside each section, clear of the encoder delay and its ramp.
  const silent = mean(values.slice(2, 9));
  const loud = mean(values.slice(13, 29));
  const soft = mean(values.slice(33, 39));
  const after = mean(values.slice(44, 49));
  expect(silent).toBe(0);
  expect(after).toBe(0);
  // Gains scale to the stream's own range, so only the order of loudness is certain.
  expect(soft).toBeGreaterThan(0);
  expect(loud).toBeGreaterThan(soft * 1.5);
});

it("holds levels of a lead-in until the audio played starts, then counts from there", () => {
  const levels = speechLevels(true);
  levels.pushPcm(speech([{ seconds: 0.5 }, { seconds: 0.5, decibels: -30 }]), RATE, 0);
  expect(levels.count).toBe(0);
  levels.start(0.5);
  levels.finish();
  expect(levels.count).toBe(Math.ceil((0.5 + DELAY_SECONDS) / 0.05));
  // The window the cut lands in still holds the encoder delay's silence.
  expect(levels.slice(0).slice(2, 9)).toEqual(Array(7).fill(10));
});
