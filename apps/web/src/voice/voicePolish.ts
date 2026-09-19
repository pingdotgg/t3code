import type { ComposerVoiceCommit, ComposerVoiceDraft } from "./composerVoiceSession";

export function captureVoicePolish(draft: ComposerVoiceDraft): ComposerVoiceDraft {
  return draft.selectionStart === draft.selectionEnd
    ? { ...draft, selectionStart: 0, selectionEnd: draft.text.length }
    : draft;
}

/** AI suggestions never overwrite typing, another answer, or another thread. */
export function resolveVoicePolishCommit(
  captured: ComposerVoiceDraft,
  current: ComposerVoiceDraft | null,
  text: string,
): ComposerVoiceCommit | null {
  if (
    !current ||
    current.ownerKey !== captured.ownerKey ||
    current.text !== captured.text ||
    !text.trim()
  )
    return null;
  return {
    rangeStart: captured.selectionStart,
    rangeEnd: captured.selectionEnd,
    expectedText: captured.text.slice(captured.selectionStart, captured.selectionEnd),
    insertion: text,
  };
}

/** Undo is guarded against the entire polished draft, just like applying a result. */
export function captureVoicePolishUndo(captured: ComposerVoiceDraft, text: string) {
  return {
    captured: {
      ...captured,
      text:
        captured.text.slice(0, captured.selectionStart) +
        text +
        captured.text.slice(captured.selectionEnd),
      selectionEnd: captured.selectionStart + text.length,
    },
    text: captured.text.slice(captured.selectionStart, captured.selectionEnd),
  };
}
