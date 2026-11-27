import { expect, it } from "vite-plus/test";
import { alignedWords, mp3Duration, speechLevels } from "./synthesisTimings.ts";

it("counts MP3 playing time across split chunks and after an ID3 tag", () => {
  // MPEG-1 Layer III at 64 kbps and 44.1 kHz: 208 bytes and 1152 samples per frame.
  const frame = Uint8Array.from({ length: 208 }, (_, index) =>
    index === 0 ? 0xff : index === 1 ? 0xfb : index === 2 ? 0x50 : 0,
  );
  const tag = Uint8Array.of(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 3, 0xff, 0xfb, 0x50);
  const bytes = Uint8Array.from([...tag, ...frame, ...frame, ...frame.subarray(0, 100)]);
  const duration = mp3Duration();
  for (let at = 0; at < bytes.length; at += 7) duration.push(bytes.subarray(at, at + 7));
  expect(duration.seconds).toBeCloseTo((2 * 1152) / 44100, 9);
});

it("builds words from character alignment that spans chunks", () => {
  const text = "Hi 🙂 there, you";
  const characters = Array.from(text);
  const times = characters.map((character, index) =>
    character === "🙂" ? [index / 10, index / 10] : [index / 10, (index + 1) / 10],
  );
  const words = alignedWords(text);
  const alignment = (from: number, to: number) => ({
    characters: characters.slice(from, to),
    character_start_times_seconds: times.slice(from, to).map(([start]) => start!),
    character_end_times_seconds: times.slice(from, to).map(([, end]) => end!),
  });
  const spoken = [...words.push(alignment(0, 6)), ...words.push(alignment(6, 99)), ...words.end()];
  expect(spoken.map((word) => [text.slice(word.start, word.end), word.startSeconds])).toEqual([
    ["Hi", 0],
    ["there,", 0.5],
    ["you", 1.2],
  ]);
  const mismatch = alignedWords("Hi there");
  expect([...mismatch.push(alignment(0, 6)), ...mismatch.end()]).toEqual([
    { start: 0, end: 2, startSeconds: 0, endSeconds: 0.2 },
  ]);
});

it("measures loudness in windows centered on the audio's clock, silence as 0 and loud as 1", () => {
  const rate = 15_000;
  // Windows of silence, a square wave at -30 dB (halfway up the meter), and one at full scale.
  const amplitudes = [0, Math.round(0x8000 * Math.sqrt(1e-3)), 0x7fff];
  const pcm = Int16Array.from({ length: 3_000 }, (_, index) => {
    const amplitude = amplitudes[Math.floor(index / 1_000)]!;
    return index % 2 ? amplitude : -amplitude;
  });
  expect(speechLevels(pcm, rate, 2)).toEqual([
    { seconds: 2.033, level: 0 },
    { seconds: 2.1, level: 0.5 },
    { seconds: 2.167, level: 1 },
  ]);
});
