import * as Schema from "effect/Schema";

export const TranscriptionPostProcessingOutput = Schema.Struct({
  transcription: Schema.String,
});

export function buildTranscriptionPostProcessingPrompt(
  instructions: string,
  transcript: string,
  draft?: {
    readonly text: string;
    readonly selection: { readonly start: number; readonly end: number };
  },
) {
  const transcriptBlock = `<transcript>\n${transcript}\n</transcript>`;
  const start = Math.max(0, Math.min(draft?.selection.start ?? 0, draft?.text.length ?? 0));
  const end = Math.max(start, Math.min(draft?.selection.end ?? start, draft?.text.length ?? 0));
  const placement =
    start === end
      ? "The transcript will be inserted at the cursor between composer_before and composer_after."
      : "The transcript will replace composer_selection between composer_before and composer_after.";
  const context = draft
    ? `\n\n${placement} Use the composer draft as a vocabulary reference. When a name or technical term in the transcript sounds like one written in the draft, use the draft's exact spelling, even if the transcript's spelling would not be an obvious error on its own. Only do this when they clearly refer to the same term. Do not copy other composer text into the result. Return only the cleaned transcript.\n<composer_before>\n${draft.text.slice(0, start)}\n</composer_before>\n<composer_selection>\n${draft.text.slice(start, end)}\n</composer_selection>\n<composer_after>\n${draft.text.slice(end)}\n</composer_after>`
    : "";
  return {
    prompt: `${instructions}\n\n${transcriptBlock}${context}`,
    outputSchema: TranscriptionPostProcessingOutput,
  };
}
