import { DEFAULT_SPEECH_POST_PROCESSING_PROMPT } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTranscriptionPostProcessingPrompt } from "./TranscriptionPostProcessing.ts";

describe("buildTranscriptionPostProcessingPrompt", () => {
  it.each([
    { mode: "default", instructions: DEFAULT_SPEECH_POST_PROCESSING_PROMPT },
    { mode: "custom", instructions: "Clean up my dictation." },
  ])("requires the structured transcription reply with $mode instructions", ({ instructions }) => {
    const prompt = buildTranscriptionPostProcessingPrompt(instructions, "hello world", {
      text: "",
      selection: { start: 0, end: 0 },
    });
    expect(prompt).toContain(
      'Return a JSON object with one key, "transcription", holding the cleaned transcript.',
    );
  });

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
