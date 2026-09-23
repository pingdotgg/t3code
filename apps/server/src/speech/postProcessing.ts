import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildTranscriptionPostProcessingPrompt } from "../textGeneration/TranscriptionPostProcessing.ts";

export const postProcessTranscript = Effect.fn("speech.postProcessTranscript")(function* (input: {
  readonly transcript: string;
  readonly cwd: string;
  readonly settings: ServerSettings;
  readonly textGeneration: TextGeneration.TextGeneration["Service"];
}) {
  if (!input.settings.speechPostProcessingEnabled || input.transcript.trim().length === 0) {
    return input.transcript;
  }
  const selectedPrompt = input.settings.speechPostProcessingPrompts.find(
    (prompt) => prompt.id === input.settings.speechPostProcessingSelectedPromptId,
  );
  if (!selectedPrompt) return input.transcript;
  const { prompt } = buildTranscriptionPostProcessingPrompt(
    input.settings.speechCorrectionWord.trim()
      ? `${selectedPrompt.prompt}\n\nCorrection cue: ${JSON.stringify(input.settings.speechCorrectionWord.trim())}. Only when this cue clearly marks a spoken self-correction, apply the correction the speaker made and omit the cue from the result. The correction may revise, add to, or retract earlier speech. Preserve everything else. If the cue is an intended part of the sentence, keep it. Use the surrounding context to decide; do not assume every occurrence is a correction.`
      : selectedPrompt.prompt,
    input.transcript,
  );
  const generated = yield* input.textGeneration.generateTranscriptionPostProcessing({
    cwd: input.cwd,
    prompt,
    modelSelection: input.settings.speechPostProcessingModelSelection,
  });
  const text = generated.transcription.trim();
  return text.length > 0 ? text : input.transcript;
});
