import * as Schema from "effect/Schema";

export const TranscriptionPostProcessingOutput = Schema.Struct({
  transcription: Schema.String,
});

export function buildTranscriptionPostProcessingPrompt(instructions: string, transcript: string) {
  const transcriptBlock = `<transcript>\n${transcript}\n</transcript>`;
  return {
    prompt: instructions.includes("${output}")
      ? instructions.replaceAll("${output}", transcriptBlock)
      : `${instructions}\n\n${transcriptBlock}`,
    outputSchema: TranscriptionPostProcessingOutput,
  };
}
