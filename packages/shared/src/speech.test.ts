import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, SPEECH_MAX_OPTIONS_BYTES } from "@t3tools/contracts";
import {
  decodeSpeechPcmRequest,
  encodeSpeechPcmRequest,
  mergeSpeechCustomWords,
} from "./speech.ts";

const word = (term: string, aliases: string[] = []) => ({ term, aliases });

describe("speech request preferences", () => {
  it("round-trips Unicode vocabulary and unaligned PCM without changing audio bytes", () => {
    const pcm = new Uint8Array(new Float32Array([0.25, -0.5]).buffer);
    const options = {
      ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      speechLanguage: "fr",
      speechCustomWords: [word("Éclair", ["e clair"])],
      projectName: "T3 Code",
    };
    const body = encodeSpeechPcmRequest(pcm, options);
    const pool = new Uint8Array(body.length + 3);
    pool.set(body, 3);
    expect(decodeSpeechPcmRequest(pool.subarray(3))).toEqual({ pcm, options });
  });

  it("rejects malformed metadata lengths, invalid preferences and missing audio", () => {
    expect(() => decodeSpeechPcmRequest(new Uint8Array(3))).toThrow();
    const invalid = new Uint8Array(5);
    new DataView(invalid.buffer).setUint32(0, SPEECH_MAX_OPTIONS_BYTES + 1, true);
    expect(() => decodeSpeechPcmRequest(invalid)).toThrow();
    expect(() =>
      decodeSpeechPcmRequest(
        encodeSpeechPcmRequest(new Uint8Array(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS),
      ),
    ).toThrow();
    expect(() =>
      encodeSpeechPcmRequest(new Uint8Array(4), {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechCustomWords: [word("Same"), word("same")],
      }),
    ).toThrow();
  });

  it("gives project terms and aliases precedence over personal spellings", () => {
    expect(
      mergeSpeechCustomWords(
        [word("MiniMax", ["mini max", "small max"]), word("Other", ["MINI MAX", "other name"])],
        [word("ProjectMax", ["mini max"])],
      ),
    ).toEqual([
      word("ProjectMax", ["mini max"]),
      word("MiniMax", ["small max"]),
      word("Other", ["other name"]),
    ]);
  });

  it("rejects oversized combined vocabulary without silently dropping words", () => {
    const personal = Array.from({ length: 100 }, (_, index) => word(`Word ${index}`));
    const combined = mergeSpeechCustomWords(personal, [word("Project term")]);
    expect(combined).toHaveLength(101);
    expect(() =>
      encodeSpeechPcmRequest(new Uint8Array(4), {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechCustomWords: combined,
      }),
    ).toThrow();
  });
});
