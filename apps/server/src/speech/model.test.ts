import { expect, it } from "vite-plus/test";

import catalog from "./catalog.json" with { type: "json" };
import {
  DEFAULT_SPEECH_MODEL_ID,
  effectiveSpeechLanguage,
  getSpeechModel,
  SPEECH_MODELS,
} from "./model.ts";

it("offers the full eligible catalog through one canonical registry", () => {
  const ids = new Set(SPEECH_MODELS.map((model) => model.id));
  expect(ids).toEqual(new Set(catalog.models.map((model) => model.id)));
  expect(ids.size).toBe(SPEECH_MODELS.length);
  expect(new Set(SPEECH_MODELS.map((model) => model.filename)).size).toBe(SPEECH_MODELS.length);
  expect(getSpeechModel(DEFAULT_SPEECH_MODEL_ID)).toBeDefined();
  for (const id of ["parakeet-ultra", "orukeet", "granite-speech-5.0-470m-turboctc"]) {
    expect(getSpeechModel(`handy-computer/${id}-gguf`)).toBeDefined();
  }
  for (const id of [
    "canary-1b",
    "granite-speech-5.0-470m-turboctc-nc",
    "lang-id-voxlingua107-ecapa",
    "silero-vad-v6.2",
    "diar_streaming_sortformer_4spk-v2.1",
  ]) {
    expect(getSpeechModel(`handy-computer/${id}-gguf`)).toBeUndefined();
  }
});

it("uses refreshed default files and preserves forced language choices", () => {
  expect(getSpeechModel("handy-computer/canary-180m-flash-gguf")).toMatchObject({
    revision: "46b86384d1db59108d6e060a0fc00924cb58499f",
    size: 218447648,
    sha256: "f942ab746040b531a29ab78ca3afc8dc9564efd8e4c942b5541e53644be9c408",
  });
  expect(getSpeechModel("handy-computer/canary-1b-v2-gguf")?.filename).toBe(
    "canary-1b-v2-Q8_0.gguf",
  );
  expect(getSpeechModel("handy-computer/canary-qwen-2.5b-gguf")?.filename).toBe(
    "canary-qwen-2.5b-Q8_0.gguf",
  );
  expect(getSpeechModel("handy-computer/canary-1b-flash-gguf")?.filename).toBe(
    "canary-1b-flash-Q8_0.gguf",
  );
  expect(
    getSpeechModel("handy-computer/multitalker-parakeet-streaming-0.6b-v1-gguf"),
  ).toMatchObject({
    revision: "d9ed2931bc10058f79809bd88139a27c2ef09a53",
    size: 873443456,
    sha256: "cf83cedc6777d2528a4d2a8a4bf476174ef7e5c65b86bc6c955f4cc9f5951ac5",
  });
  expect(getSpeechModel("handy-computer/granite-speech-5.0-470m-turboctc-gguf")).toMatchObject({
    languages: ["en"],
    supportsStreaming: false,
    supportsLanguageDetection: false,
    supportsTranslation: false,
  });
  const nemotron = getSpeechModel("handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf")!;
  expect(effectiveSpeechLanguage(nemotron, "fr")).toBe("fr");
  expect(effectiveSpeechLanguage(nemotron, "en")).toBe("en");
  expect(effectiveSpeechLanguage(nemotron, "auto")).toBe("auto");
  expect(nemotron.languages.filter((language) => language === "fr")).toHaveLength(1);
});
