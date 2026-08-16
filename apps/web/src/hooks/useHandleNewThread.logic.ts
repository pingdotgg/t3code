import type { ScopedThreadRef } from "@t3tools/contracts";

export type StoredDraftReuseDecision = "reuse" | "mint";

/**
 * Decide whether a project's stored new-thread draft can keep its thread id.
 *
 * An id that already exists in any lifecycle (live, archived, deleted) is
 * burned. Promoted/sent drafts are never reused, even when both snapshots miss
 * them. An unloaded archive snapshot is unknown, not absent.
 */
export function decideStoredDraftReuse(input: {
  readonly storedDraftThreadRef: ScopedThreadRef | null;
  readonly liveShellExists: boolean;
  readonly archivedShellExists: boolean | null;
  readonly deletedShellExists?: boolean | null;
  readonly promoted: boolean;
}): StoredDraftReuseDecision {
  if (input.storedDraftThreadRef === null) {
    return "mint";
  }
  if (input.liveShellExists) {
    return "mint";
  }
  if (input.archivedShellExists === true) {
    return "mint";
  }
  if (input.deletedShellExists === true) {
    return "mint";
  }
  if (input.promoted) {
    return "mint";
  }
  return "reuse";
}
