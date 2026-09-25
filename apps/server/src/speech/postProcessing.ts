import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildTranscriptionPostProcessingPrompt } from "../textGeneration/TranscriptionPostProcessing.ts";
import { applySpeechAliases } from "./customWords.ts";

const quoteCorrectionWord = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const postProcessTranscript = Effect.fn("speech.postProcessTranscript")(function* (input: {
  readonly transcript: string;
  readonly cwd: string;
  readonly settings: ServerSettings;
}) {
  if (!input.settings.speechPostProcessingEnabled || input.transcript.trim().length === 0) {
    return input.transcript;
  }
  const selectedPrompt = input.settings.speechPostProcessingPrompts.find(
    (prompt) => prompt.id === input.settings.speechPostProcessingSelectedPromptId,
  );
  if (!selectedPrompt) return input.transcript;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const { prompt } = buildTranscriptionPostProcessingPrompt(
    input.settings.speechCorrectionWord.trim()
      ? `${selectedPrompt.prompt}\n\nCorrection cue: ${quoteCorrectionWord(input.settings.speechCorrectionWord.trim())}. Only when this cue clearly marks a spoken self-correction, apply the correction the speaker made and omit the cue from the result. The correction may revise, add to, or retract earlier speech. Preserve everything else. If the cue is an intended part of the sentence, keep it. Use the surrounding context to decide; do not assume every occurrence is a correction.`
      : selectedPrompt.prompt,
    input.transcript,
  );
  const generated = yield* textGeneration.generateTranscriptionPostProcessing({
    cwd: input.cwd,
    prompt,
    modelSelection: input.settings.speechPostProcessingModelSelection,
  });
  const text = generated.transcription.trim();
  return text.length > 0
    ? applySpeechAliases(text, input.settings.speechCustomWords)
    : input.transcript;
});
