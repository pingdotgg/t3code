import {
  resolveTranscriptCommit,
  type VoiceDraftSnapshot,
} from "@t3tools/client-runtime/voice-input";

/** Rebase a captured insertion point only across an edit wholly before/after it. */
export function resolveDesktopTranscript(
  captured: VoiceDraftSnapshot,
  current: VoiceDraftSnapshot | null,
  transcript: string,
  locale: string,
): ReturnType<typeof resolveTranscriptCommit> {
  if (!current || current.ownerKey !== captured.ownerKey) return { kind: "stale" };
  let position = captured.selection.start;
  if (current.text !== captured.text) {
    let prefix = 0;
    while (
      prefix < captured.text.length &&
      prefix < current.text.length &&
      captured.text[prefix] === current.text[prefix]
    )
      prefix++;
    let suffix = 0;
    while (
      suffix < captured.text.length - prefix &&
      suffix < current.text.length - prefix &&
      captured.text[captured.text.length - suffix - 1] ===
        current.text[current.text.length - suffix - 1]
    )
      suffix++;
    const end = captured.text.length - suffix;
    if (position <= prefix) {
      /* Insertion remains before the user's later edit. */
    } else if (position >= end) position += current.text.length - captured.text.length;
    else return { kind: "stale" };
  } else if (current.revision !== captured.revision) return { kind: "stale" };
  const rebased = { ...current, selection: { start: position, end: position } };
  return resolveTranscriptCommit(rebased, rebased, transcript, locale);
}
