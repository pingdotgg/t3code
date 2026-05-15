import type { RewindCheckpointCandidate } from "./MessagesTimeline.logic";

export function checkpointRewindLabel(turnCount: number): string {
  return turnCount === 0 ? "Before first turn" : `Checkpoint ${turnCount}`;
}

export function normalizeRewindSearch(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function promptPreview(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : "(empty prompt)";
}

export function filterRewindCheckpointCandidates(
  candidates: ReadonlyArray<RewindCheckpointCandidate>,
  query: string,
): RewindCheckpointCandidate[] {
  const normalizedQuery = normalizeRewindSearch(query);
  if (normalizedQuery.length === 0) {
    return [...candidates];
  }
  return candidates.filter((candidate) =>
    normalizeRewindSearch(candidate.prompt).includes(normalizedQuery),
  );
}

export function isRewindRestoreDisabled(input: {
  isReverting: boolean;
  disabledReason: string | null;
  selected: RewindCheckpointCandidate | null;
}): boolean {
  return input.isReverting || input.disabledReason !== null || input.selected === null;
}
