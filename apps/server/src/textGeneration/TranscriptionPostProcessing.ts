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
  const cursor = Math.max(0, Math.min(draft?.selection.start ?? 0, draft?.text.length ?? 0));
  const selectionEnd = Math.max(
    cursor,
    Math.min(draft?.selection.end ?? cursor, draft?.text.length ?? 0),
  );
  const placement =
    selectionEnd > cursor
      ? "The transcript will replace the selected text between composer_before and composer_after. The selected text is omitted from this context."
      : "The transcript will be inserted at the cursor between composer_before and composer_after.";
  const context = draft
    ? `\n\n${placement} Use the composer draft and insertion position to resolve ambiguity and correct likely recognition errors in the transcript. The draft can clarify the topic, references, terminology, and how the new speech fits with nearby text. Prefer an interpretation supported by the draft when the speech plausibly matches it. Do not invent content, change clear speech, or include existing composer text in the result. Return only the cleaned transcript.\n<composer_before>\n${draft.text.slice(0, cursor)}\n</composer_before>\n<composer_after>\n${draft.text.slice(selectionEnd)}\n</composer_after>`
    : "";
  return {
    prompt: `${instructions}\n\n${transcriptBlock}${context}`,
    outputSchema: TranscriptionPostProcessingOutput,
  };
}
