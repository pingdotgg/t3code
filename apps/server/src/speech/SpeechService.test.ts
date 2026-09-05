import { describe, expect, it } from "vite-plus/test";

import { decodeSpeechPcm, MAX_SPEECH_BYTES } from "./SpeechService.ts";

const bytes = (samples: Float32Array) => new Uint8Array(samples.buffer);

describe("environment speech PCM", () => {
  it("copies valid PCM and preserves its samples", () => {
    const input = new Float32Array([0.25, -0.5]);
    const decoded = decodeSpeechPcm(bytes(input));
    expect([...decoded]).toEqual([0.25, -0.5]);
    input[0] = 1;
    expect(decoded[0]).toBe(0.25);
  });

  it("treats silence as an empty transcript", () => {
    expect(decodeSpeechPcm(bytes(new Float32Array(16_000))).length).toBe(0);
  });

  it("preserves invalid audio as a structured domain error", () => {
    try {
      decodeSpeechPcm(new Uint8Array(3));
      throw new Error("expected invalid audio");
    } catch (error) {
      expect(error).toMatchObject({ _tag: "SpeechInvalidAudioError", byteLength: 3 });
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("rejects malformed, invalid, and oversized input", () => {
    expect(() => decodeSpeechPcm(new Uint8Array())).toThrow();
    expect(() => decodeSpeechPcm(new Uint8Array(3))).toThrow();
    expect(() => decodeSpeechPcm(bytes(new Float32Array([Number.NaN])))).toThrow();
    expect(() => decodeSpeechPcm(new Uint8Array(MAX_SPEECH_BYTES + 4))).toThrow();
  });
});
