/**
 * Mirrors the Codex composer boundary rule: trim the transcript, append it to
 * the end, and add exactly one space only when the existing draft needs one.
 */
export function appendVoiceTranscript(existing: string, transcript: string): string {
  const normalized = transcript.trim();
  if (normalized.length === 0) return existing;
  if (existing.length === 0 || /\s$/.test(existing)) return `${existing}${normalized}`;
  return `${existing} ${normalized}`;
}

export type VoiceTranscriptionAction = "insert" | "send" | "abort";

/**
 * Keeps a single terminal outcome for a recording. Cancellation always wins;
 * pressing Send can upgrade an already-requested insert while transcription is
 * being finalized.
 */
export function resolveVoiceTranscriptionAction(
  current: VoiceTranscriptionAction | null,
  next: VoiceTranscriptionAction,
): VoiceTranscriptionAction {
  if (current === "abort" || next === "abort") return "abort";
  if (current === "send" || next === "send") return "send";
  return "insert";
}
