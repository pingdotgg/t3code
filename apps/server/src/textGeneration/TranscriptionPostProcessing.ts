const quoteCue = (cue: string) => JSON.stringify(cue);

/** Builds the cleanup prompt: instructions, the transcript, and the draft around the insertion point. */
export function buildTranscriptionPostProcessingPrompt(
  instructions: string,
  transcript: string,
  draft: {
    readonly text: string;
    readonly selection: { readonly start: number; readonly end: number };
  },
  correctionCue = "",
): string {
  const cue = correctionCue.trim();
  const cueInstructions = cue
    ? `\n\nCorrection cue: ${quoteCue(cue)}. Only when this cue clearly marks a spoken self-correction, apply the correction the speaker made and omit the cue from the result. The correction may revise, add to, or retract earlier speech. Preserve everything else. If the cue is an intended part of the sentence, keep it. Use the surrounding context to decide; do not assume every occurrence is a correction.`
    : "";
  const cursor = Math.max(0, Math.min(draft.selection.start, draft.text.length));
  const selectionEnd = Math.max(cursor, Math.min(draft.selection.end, draft.text.length));
  const replacesSelection = selectionEnd > cursor;
  const placement = replacesSelection
    ? "The transcript will replace composer_selection between composer_before and composer_after. Use the selected text only as context for terminology and references; it will not remain in the draft. Do not preserve or copy it into the result unless the new speech itself says it."
    : "The transcript will be inserted at the cursor between composer_before and composer_after.";
  const selectionBlock = replacesSelection
    ? `\n<composer_selection>\n${draft.text.slice(cursor, selectionEnd)}\n</composer_selection>`
    : "";
  return `${instructions}${cueInstructions}

<transcript>
${transcript}
</transcript>

${placement} Use the composer draft and insertion position to resolve ambiguity and correct likely recognition errors in the transcript. The draft can clarify the topic, references, terminology, and how the new speech fits with nearby text. Prefer an interpretation supported by the draft when the speech plausibly matches it. Do not invent content, change clear speech, or include existing composer text in the result. Return only the cleaned transcript. Return a JSON object with one key, "transcription", holding the cleaned transcript.
<composer_before>
${draft.text.slice(0, cursor)}
</composer_before>${selectionBlock}
<composer_after>
${draft.text.slice(selectionEnd)}
</composer_after>`;
}
