import type { TranscriptView } from "@t3tools/contracts";

export const TRANSCRIPT_VIEW_LABELS: Record<TranscriptView, string> = {
  normal: "Normal",
  thinking: "Thinking",
  verbose: "Verbose",
};

/** Turn folds, tool and subagent groups, and superseded attempts. */
export function transcriptFoldsStartOpen(view: TranscriptView): boolean {
  return view !== "normal";
}

/** A row's own details, such as thinking text and tool output. */
export function transcriptRowsStartOpen(view: TranscriptView): boolean {
  return view === "verbose";
}

/** Disclosure sets hold the ids flipped away from the transcript's default state. */
export function disclosureOpen<Id>(
  flipped: ReadonlySet<Id> | undefined,
  id: Id,
  startsOpen: boolean,
): boolean {
  return (flipped?.has(id) ?? false) !== startsOpen;
}

export function withDisclosureOpen<Id>(
  flipped: ReadonlySet<Id>,
  id: Id,
  startsOpen: boolean,
): ReadonlySet<Id> {
  if (disclosureOpen(flipped, id, startsOpen)) return flipped;
  const next = new Set(flipped);
  if (startsOpen) next.delete(id);
  else next.add(id);
  return next;
}
