import type { AgentSessionProjectCandidate } from "@t3tools/contracts";

const RECENT_PROJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Keep imported projects visible to the empty-state decision without offering them twice. */
export function partitionOnboardingProjects(
  candidates: ReadonlyArray<AgentSessionProjectCandidate>,
  now = Date.now(),
) {
  const available = candidates.filter((candidate) => !candidate.alreadyImported);
  const cutoff = now - RECENT_PROJECT_WINDOW_MS;

  return {
    available,
    recent: available.filter(
      (candidate) =>
        candidate.lastActiveAt !== null && Date.parse(candidate.lastActiveAt) >= cutoff,
    ),
    alreadyImportedCount: candidates.length - available.length,
  };
}
