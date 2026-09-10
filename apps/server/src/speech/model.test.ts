// @effect-diagnostics nodeBuiltinImport:off - exercises sparse native model files without downloading a model.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { isSpeechModelReady, SPEECH_MODELS } from "./model.ts";

describe("speech model catalog", () => {
  it("contains unique ids and filenames", () => {
    expect(new Set(SPEECH_MODELS.map((model) => model.id)).size).toBe(SPEECH_MODELS.length);
    expect(new Set(SPEECH_MODELS.map((model) => model.filename)).size).toBe(SPEECH_MODELS.length);
  });
});

it("checks readiness without reading the model contents", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "speech-status-"));
  try {
    const speechModel = SPEECH_MODELS[0];
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
