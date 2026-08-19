import type { ThreadHandoff } from "@t3tools/contracts";

export function presentThreadHandoff(handoff: ThreadHandoff) {
  return {
    accessibilityLabel: `Thread handoff: ${handoff.title}`,
    openLabel: `Open ${handoff.title} thread`,
    artifactReferences:
      handoff.artifactReferences.length > 0 ? handoff.artifactReferences.join(" · ") : null,
  };
}
