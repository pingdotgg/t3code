import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, SPEECH_MAX_OPTIONS_BYTES } from "@t3tools/contracts";

import {
  decodeSpeechPcmRequest,
  encodeSpeechPcmRequest,
  recommendSpeechModel,
  resolveSpeechVocabulary,
} from "./speech.ts";

describe("speech PCM request framing", () => {
  it("round-trips options and unaligned PCM without changing audio bytes", () => {
    const pcm = new Uint8Array(new Float32Array([0.25, -0.5]).buffer);
    const options = { ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, speechLanguage: "fr" };
    const body = encodeSpeechPcmRequest(pcm, options);
    const pool = new Uint8Array(body.length + 3);
    pool.set(body, 3);
    expect(decodeSpeechPcmRequest(pool.subarray(3))).toEqual({ pcm, options });
  });

  it("accepts recordings from clients that predate silence filtering", () => {
    const metadata = new TextEncoder().encode(
      JSON.stringify({
        speechLanguage: "fr",
        speechTranslateToEnglish: false,
        speechCustomWords: [],
        speechRemoveFillerWords: false,
      }),
    );
    const body = new Uint8Array(4 + metadata.length + 4);
    new DataView(body.buffer).setUint32(0, metadata.length, true);
    body.set(metadata, 4);
    expect(decodeSpeechPcmRequest(body).options).toEqual({
      ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      speechLanguage: "fr",
      speechRemoveFillerWords: false,
      speechSilenceFiltering: true,
    });
  });

  it("rejects truncated frames, oversized option lengths and missing audio", () => {
    expect(() => decodeSpeechPcmRequest(new Uint8Array(3))).toThrow();
    const oversized = new Uint8Array(5);
    new DataView(oversized.buffer).setUint32(0, SPEECH_MAX_OPTIONS_BYTES + 1, true);
    expect(() => decodeSpeechPcmRequest(oversized)).toThrow();
    expect(() =>
      decodeSpeechPcmRequest(
        encodeSpeechPcmRequest(new Uint8Array(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS),
      ),
    ).toThrow();
  });
});

describe("resolveSpeechVocabulary", () => {
  it("prefers project spellings, keeps hints under the cap, and drops duplicates", () => {
    const personal = Array.from({ length: 100 }, (_, index) => ({
      term: `word${index}`,
      aliases: index === 0 ? ["Effect"] : [],
    }));
    const resolved = resolveSpeechVocabulary({
      personal,
      project: [{ term: "effect", aliases: ["a fact"] }],
      hints: ["  T3   Code ", "word1", "", "x".repeat(51)],
    });
    expect(resolved).toHaveLength(100);
    expect(resolved.slice(0, 3)).toEqual([
      { term: "T3 Code", aliases: [] },
      { term: "effect", aliases: ["a fact"] },
      { term: "word0", aliases: [] },
    ]);
    expect(resolved.filter(({ term }) => term === "word1")).toHaveLength(1);
    expect(resolved.at(-1)?.term).toBe("word97");
  });
});

describe("recommendSpeechModel", () => {
  const catalog = [
    {
      id: "unrecommended",
      languages: ["en", "de", "es"],
      supportsLanguageDetection: true,
      recommended: false,
    },
    { id: "english", languages: ["en"], supportsLanguageDetection: false, recommended: true },
    { id: "fixed", languages: ["en", "de"], supportsLanguageDetection: false, recommended: true },
    {
      id: "detecting",
      languages: ["en", "de", "fr"],
      supportsLanguageDetection: true,
      recommended: true,
    },
  ];

  it.each([
    {
      name: "keeps the English default for an English speaker",
      input: { selectedModelId: "english", intent: "auto", preferred: ["en"] },
      expected: { id: "english", language: "en" },
    },
    {
      name: "skips a recommended model that would transcribe English instead of German",
      input: { selectedModelId: "english", intent: "auto", preferred: ["de", "en"] },
      expected: { id: "detecting", language: "de" },
    },
    {
      name: "accepts a model without language detection for an explicit language",
      input: { selectedModelId: "english", intent: "de", preferred: ["en"] },
      expected: { id: "fixed", language: "de" },
    },
    {
      name: "keeps a selected model that is not recommended but transcribes German",
      input: { selectedModelId: "unrecommended", intent: "auto", preferred: ["de"] },
      expected: { id: "unrecommended", language: "de" },
    },
    {
      name: "moves on to the next preferred language that a model transcribes",
      input: { selectedModelId: "english", intent: "auto", preferred: ["ja", "fr"] },
      expected: { id: "detecting", language: "fr" },
    },
    {
      name: "falls back to a model that is not recommended when no other transcribes the language",
      input: { selectedModelId: "english", intent: "auto", preferred: ["es"] },
      expected: { id: "unrecommended", language: "es" },
    },
    {
      name: "offers nothing when no model transcribes the language",
      input: { selectedModelId: "english", intent: "auto", preferred: ["ja"] },
      expected: undefined,
    },
  ])("$name", ({ input, expected }) => {
    const choice = recommendSpeechModel(catalog, input);
    expect(choice ? { id: choice.model.id, language: choice.language } : undefined).toEqual(
      expected,
    );
  });
});
