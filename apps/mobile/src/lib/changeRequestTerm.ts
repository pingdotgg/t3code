import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

/** Selects the noun in translated sentences, so each language writes the whole sentence per host term. */
type ChangeRequestTermKind = "mr" | "cr" | "pr";

export function changeRequestTermKind(
  terminology: Pick<ChangeRequestTerminology, "singular">,
): ChangeRequestTermKind {
  if (terminology.singular === "merge request") return "mr";
  // Entire's "trail" has no translated sentences of its own; "change request" is the closest.
  if (terminology.singular === "change request" || terminology.singular === "trail") return "cr";
  return "pr";
}
