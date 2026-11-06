// Adapted from TraceDecay's add-time classification (session-memory/src/memory/diff.rs), whose
// cue list derives from mnemon (Apache-2.0). TraceDecay compares holographic vectors; this uses
// token overlap only, so the thresholds sit lower than TraceDecay's.
import type { KnowledgeConflictHint, ProjectFactId } from "@t3tools/contracts";
import { projectMemorySearchTokens } from "./holographicScoring.ts";

const NEAR_DUPLICATE_SIMILARITY = 0.85;
const POSSIBLE_CONFLICT_SIMILARITY = 0.55;

// Bare "not" is excluded on purpose: it appears constantly in ordinary prose and would flag
// unrelated facts as conflicts.
const STATE_CHANGE_CUES = [
  "no longer",
  "switched from",
  "switched to",
  "instead of",
  "rather than",
  "replaced",
  "supersedes",
  "superseded",
  "deprecated",
];

function containsStateChangeCue(text: string): boolean {
  const lower = text.toLowerCase();
  return STATE_CHANGE_CUES.some((cue) => lower.includes(cue));
}

export const normalizeFactContent = (text: string) =>
  text.split(/\s+/).filter(Boolean).join(" ").toLowerCase();

/** Dice coefficient over the same tokens recall uses. */
function lexicalSimilarity(left: string, right: string): number {
  const a = projectMemorySearchTokens(left);
  const b = new Set(projectMemorySearchTokens(right));
  if (a.length === 0 || b.size === 0) return 0;
  const shared = a.filter((token) => b.has(token)).length;
  return (2 * shared) / (a.length + b.size);
}

export function conflictHints(
  content: string,
  candidates: ReadonlyArray<{
    readonly id: ProjectFactId;
    readonly revision: number;
    readonly content: string;
  }>,
): ReadonlyArray<KnowledgeConflictHint> {
  const cue = containsStateChangeCue(content);
  const hints: KnowledgeConflictHint[] = [];
  for (const candidate of candidates) {
    const base = {
      factId: candidate.id,
      revision: candidate.revision,
      excerpt: candidate.content.slice(0, 320),
    };
    if (normalizeFactContent(content) === normalizeFactContent(candidate.content)) {
      hints.push({ ...base, kind: "duplicate", similarity: 1 });
      continue;
    }
    const similarity = Math.round(lexicalSimilarity(content, candidate.content) * 1000) / 1000;
    if (
      similarity >= POSSIBLE_CONFLICT_SIMILARITY &&
      (cue || containsStateChangeCue(candidate.content))
    )
      hints.push({ ...base, kind: "possible_conflict", similarity });
    else if (similarity > NEAR_DUPLICATE_SIMILARITY)
      hints.push({ ...base, kind: "near_duplicate", similarity });
  }
  return hints
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        (left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0),
    )
    .slice(0, 3);
}
