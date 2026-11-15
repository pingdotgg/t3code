import { expect, it } from "vite-plus/test";
import { createSpeechAudio } from "./audio.ts";

const frame = 512;
const make = (overrides = {}) =>
  createSpeechAudio({
    frameSamples: frame,
    filterSilence: true,
    nativeStreaming: false,
    longForm: false,
    maxAudioMs: 0,
    ...overrides,
  });
const frames = (count: number) =>
  Float32Array.from({ length: count * frame }, (_, i) => (Math.floor(i / frame) + 1) / 1000);
const seconds = (n: number) => Math.floor((n * 16000) / frame);

it("retains pre-roll, onset and offline/streaming tails without duplicating edges", () => {
  for (const nativeStreaming of [false, true]) {
    const audio = make({ nativeStreaming });
    const pcm = frames(100);
    const chunks: Float32Array[] = [];
    for (let i = 0; i < 100; i++) {
      audio.append(pcm.subarray(i * frame, (i + 1) * frame));
      audio.score(i, [i >= 20 && i < 24 ? 0.9 : 0]);
      chunks.push(...audio.take());
    }
    chunks.push(...audio.take(true));
    const retained = chunks.flatMap((chunk) => [...chunk]);
    expect(retained).toEqual([
      ...pcm.subarray(6 * frame, (24 + (nativeStreaming ? 52 : 15)) * frame),
    ]);
  }
});

it("handles silence, short speech, a partial last frame and disabled filtering", () => {
  const silence = make();
  silence.append(new Float32Array(frame * 4 + 7));
  silence.score(0, [0, 0, 0, 0, 0]);
  expect(silence.take(true)).toEqual([]);
  const short = make();
  short.append(new Float32Array([0.2, 0.1]));
  short.score(0, [0.8]);
  expect([...short.take(true)[0]!]).toEqual([...new Float32Array([0.2, 0.1])]);
  const raw = make({ filterSilence: false });
  const pcm = frames(50).subarray(0, 50 * frame - 3);
  raw.append(pcm);
  raw.score(0, new Array(50).fill(0));
  expect(raw.take(true)[0]).toEqual(pcm);
});

it("plans at pauses while recording and preserves ordered audio and final tails", () => {
  const audio = make({ filterSilence: false });
  const pcm = frames(seconds(100));
  const chunks: Float32Array[] = [];
  for (let start = 0; start < pcm.length; start += frame * 7) {
    const piece = pcm.subarray(start, start + frame * 7);
    audio.append(piece);
    audio.score(
      start / frame,
      Array.from({ length: piece.length / frame }, (_, i) => {
        const t = ((start / frame + i) * frame) / 16000;
        return (t >= 28 && t < 29) || (t >= 55 && t < 56) ? 0 : 1;
      }),
    );
    chunks.push(...audio.take());
  }
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0]!.length / 16000).toBeCloseTo(28.5, 1);
  chunks.push(...audio.take(true));
  expect(Float32Array.from(chunks.flatMap((chunk) => [...chunk]))).toEqual(pcm);
  expect(chunks.every((chunk) => chunk.length <= 40 * 16000)).toBe(true);
  expect(chunks.at(-1)!.length).toBeGreaterThanOrEqual(5 * 16000);
});

it("respects smaller engine limits, hard cuts, and native/internal-long-form eligibility", () => {
  for (const config of [{}, { maxAudioMs: 4000 }, { nativeStreaming: true }, { longForm: true }]) {
    const audio = make({ filterSilence: false, ...config });
    const pcm = frames(seconds(84));
    audio.append(pcm);
    audio.score(0, new Array(pcm.length / frame).fill(1));
    const live = audio.take();
    const chunks = [...live, ...audio.take(true)];
    expect(chunks.reduce((n, chunk) => n + chunk.length, 0)).toBe(pcm.length);
    if ("nativeStreaming" in config || "longForm" in config) expect(chunks).toHaveLength(1);
    else
      expect(
        chunks.every((chunk) => chunk.length <= ("maxAudioMs" in config ? 32000 : 640000)),
      ).toBe(true);
    if ("longForm" in config) expect(live).toEqual([]);
  }
});
