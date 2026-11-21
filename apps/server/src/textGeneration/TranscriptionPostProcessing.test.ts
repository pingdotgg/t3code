import { describe, expect, it } from "vite-plus/test";

import { buildTranscriptionPostProcessingPrompt } from "./TranscriptionPostProcessing.ts";

describe("buildTranscriptionPostProcessingPrompt", () => {
  it("names the correction cue only when the person set one", () => {
    const draft = { text: "Make it 42.", selection: { start: 11, end: 11 } };
    const plain = buildTranscriptionPostProcessingPrompt("Clean.", "sorry 24", draft);
    expect(plain).not.toContain("Correction cue");
    expect(plain.startsWith("Clean.\n\n<transcript>")).toBe(true);
    const cued = buildTranscriptionPostProcessingPrompt("Clean.", "sorry 24", draft, ' so"rry ');
    expect(cued).toContain('Correction cue: "so\\"rry".');
    expect(cued.indexOf("Correction cue")).toBeLessThan(cued.indexOf("<transcript>"));
  });
});
