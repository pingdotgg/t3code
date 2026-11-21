import { expect, it } from "vite-plus/test";
import { SPEECH_VOICES } from "./voices.ts";

it("pins complete Piper bundles with adjacent configuration files and unique managed names", () => {
  const filenames = new Set<string>();
  for (const voice of SPEECH_VOICES) {
    const model = voice.files.find((file) => file.filename.endsWith(".onnx"))!;
    expect(voice.files.some((file) => file.filename === `${model.filename}.json`)).toBe(true);
    expect(voice.files.some((file) => file.filename.endsWith(".modelcard"))).toBe(true);
    for (const file of voice.files) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(file.filename).not.toMatch(/[\\/]/);
      expect(file.size).toBeGreaterThan(0);
      expect(filenames.has(file.filename)).toBe(false);
      filenames.add(file.filename);
    }
  }
});
