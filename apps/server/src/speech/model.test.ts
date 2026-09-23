// @effect-diagnostics nodeBuiltinImport:off - exercises sparse native model files without downloading a model.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { effectiveSpeechLanguage, isSpeechModelReady, SPEECH_MODELS } from "./model.ts";

describe("speech model catalog", () => {
  it("contains unique ids and filenames", () => {
    expect(new Set(SPEECH_MODELS.map((model) => model.id)).size).toBe(SPEECH_MODELS.length);
    expect(new Set(SPEECH_MODELS.map((model) => model.filename)).size).toBe(SPEECH_MODELS.length);
  });

  it("offers Handy's complete pinned catalog with five recommended models", () => {
    expect(SPEECH_MODELS).toHaveLength(69);
    expect(SPEECH_MODELS.filter((model) => model.recommended)).toHaveLength(5);
    for (const model of SPEECH_MODELS) {
      expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.filename).toMatch(/\.gguf$/);
      expect(model.size).toBeGreaterThan(0);
      expect(model.languages.length).toBeGreaterThan(0);
    }
  });
});

it("resolves Auto only for models that can detect language", () => {
  const canary = SPEECH_MODELS.find((model) => model.name === "Canary 180M Flash")!;
  const whisper = SPEECH_MODELS.find((model) => model.name === "Whisper Medium")!;
  expect(effectiveSpeechLanguage(canary, "auto")).toBe("en");
  expect(effectiveSpeechLanguage(canary, "es")).toBe("es");
  expect(effectiveSpeechLanguage(whisper, "auto")).toBe("auto");
  expect(effectiveSpeechLanguage(whisper, "fr")).toBe("fr");
});

it("checks readiness without reading the model contents", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "speech-status-"));
  try {
    const speechModel = SPEECH_MODELS[0]!;
    const path = NodePath.join(directory, speechModel.filename);
    expect(await isSpeechModelReady(directory, speechModel)).toBe(false);
    await NodeFSP.writeFile(path, "");
    await NodeFSP.truncate(path, speechModel.size);
    expect(await isSpeechModelReady(directory, speechModel)).toBe(true);
    await NodeFSP.truncate(path, 1);
    expect(await isSpeechModelReady(directory, speechModel)).toBe(false);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
