import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, SPEECH_MAX_OPTIONS_BYTES } from "@t3tools/contracts";

import {
  chooseSetupSpeechModel,
  decodeSpeechPcmRequest,
  encodeSpeechPcmRequest,
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

describe("chooseSetupSpeechModel", () => {
  const model = (
    id: string,
    languages: string[],
    supportsLanguageDetection: boolean,
    recommended: boolean,
  ) => ({ id, languages, supportsLanguageDetection, recommended });
  const catalog = [
    model("unrecommended", ["en", "de", "es"], true, false),
    model("english", ["en"], false, true),
    model("fixed", ["en", "de"], false, true),
    model("detecting", ["en", "de", "fr"], true, true),
  ];

  it.each([
    [
      "keeps the selected English model for an English speaker",
      "english",
      "auto",
      ["en"],
      { id: "english", language: "en" },
    ],
    [
      "skips models that would transcribe English instead of German",
      "english",
      "auto",
      ["de", "en"],
      { id: "detecting", language: "de" },
    ],
    [
      "accepts a model without detection for a chosen language",
      "english",
      "de",
      ["en"],
      { id: "fixed", language: "de" },
    ],
    [
      "keeps a selected model that transcribes the language",
      "unrecommended",
      "auto",
      ["de"],
      { id: "unrecommended", language: "de" },
    ],
    [
      "moves on to the next preferred language a model transcribes",
      "english",
      "auto",
      ["ja", "fr"],
      { id: "detecting", language: "fr" },
    ],
    [
      "falls back to a model that is not recommended",
      "english",
      "auto",
      ["es"],
      { id: "unrecommended", language: "es" },
    ],
    ["offers nothing when no model transcribes the language", "english", "auto", ["ja"], undefined],
  ] as const)("%s", (_, selectedModelId, intent, preferred, expected) => {
    const choice = chooseSetupSpeechModel(catalog, { selectedModelId, intent, preferred });
    expect(choice && { id: choice.model.id, language: choice.language }).toEqual(expected);
  });
});
