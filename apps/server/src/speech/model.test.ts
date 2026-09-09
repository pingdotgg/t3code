// @effect-diagnostics nodeBuiltinImport:off - exercises sparse native model files without downloading a model.
import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { isSpeechModelReady, SPEECH_MODEL } from "./model.ts";

it("checks readiness without reading the model contents", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "speech-status-"));
  try {
    const path = NodePath.join(directory, SPEECH_MODEL.filename);
    expect(await isSpeechModelReady(directory)).toBe(false);
    await NodeFSP.writeFile(path, "");
    await NodeFSP.truncate(path, SPEECH_MODEL.size);
    expect(await isSpeechModelReady(directory)).toBe(true);
    await NodeFSP.truncate(path, 1);
    expect(await isSpeechModelReady(directory)).toBe(false);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
