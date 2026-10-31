import { describe, expect, it } from "@effect/vitest";
import {
  cleanWhisperText,
  isQuiet,
  concatenate,
  decodePcm,
  findSplit,
  joinTexts,
  takeOrderedChunks,
} from "./audio.ts";
import { readTar } from "./tar.ts";

function tarEntry(name: string, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("00000000001\0", 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  const sum = header.reduce((n, byte) => n + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, Buffer.from([42]), Buffer.alloc(511 + 1024)]);
}

describe("dictation audio", () => {
  it("decodes little-endian int16 PCM including signed extrema", () => {
    const pcm = Buffer.alloc(8);
    [-32768, -1, 0, 32767].forEach((sample, i) => pcm.writeInt16LE(sample, i * 2));
    expect([...decodePcm(pcm.toString("base64"))]).toEqual([-1, -1 / 32768, 0, 32767 / 32768]);
    expect(() => decodePcm("invalid!")).toThrow();
    expect(() => decodePcm("AA==")).toThrow();
  });
  it("holds gaps until concurrent chunks can be consumed in order", () => {
    const chunks = new Map([
      [2, new Float32Array([3])],
      [0, new Float32Array([1])],
    ]);
    const first = takeOrderedChunks(chunks, 0);
    expect([...concatenate(first.ordered)]).toEqual([1]);
    chunks.set(1, new Float32Array([2]));
    const second = takeOrderedChunks(chunks, first.next);
    expect([...concatenate(second.ordered)]).toEqual([2, 3]);
    expect(second.next).toBe(3);
  });
  it("waits for a pause after 4 seconds and caps uninterrupted speech at 20 seconds", () => {
    expect(findSplit(new Float32Array(3 * 16000))).toBeNull();
    const audio = new Float32Array(5 * 16000).fill(0.2);
    audio.fill(0, 4 * 16000);
    const split = findSplit(audio)!;
    expect(split).toBeGreaterThanOrEqual(4 * 16000);
    expect(split).toBeLessThan(5 * 16000);
    expect(findSplit(new Float32Array(19 * 16000).fill(0.2))).toBeNull();
    expect(findSplit(new Float32Array(21 * 16000).fill(0.2))).toBeLessThanOrEqual(20 * 16000);
  });
  it("suppresses noise and non-speech markers without deleting legitimate phrases", () => {
    expect(isQuiet(new Float32Array(16000).fill(0.0001))).toBe(true);
    expect(isQuiet(new Float32Array(16000).fill(0.1))).toBe(false);
    expect(cleanWhisperText(" [BLANK_AUDIO] ")).toBe("");
    expect(cleanWhisperText("Thank you for watching.")).toBe("Thank you for watching.");
  });
  it("joins nonempty segment texts with one separator", () => {
    expect(joinTexts([" first ", "", "  second", " "])).toBe("first second");
  });
});

describe("bounded runtime tar extraction", () => {
  it("reads regular package files and rejects traversal, links and corrupt headers", () => {
    expect(readTar(tarEntry("package/sherpa-onnx.node"))[0]?.bytes).toEqual(Buffer.from([42]));
    for (const name of ["package/../outside", "package/C:outside", "package/\\outside", "/outside"])
      expect(() => readTar(tarEntry(name))).toThrow();
    expect(() => readTar(tarEntry("package/link", "2"))).toThrow();
    const corrupt = tarEntry("package/file");
    corrupt[0] = 0;
    expect(() => readTar(corrupt)).toThrow();
  });
});
