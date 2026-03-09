import type { VcsBackend, VcsRefKind } from "@t3tools/contracts";

interface LegacyThreadVcsMetadataInput {
  readonly vcsBackend?: VcsBackend | undefined;
  readonly refName?: string | null | undefined;
  readonly refKind?: VcsRefKind | null | undefined;
  readonly workspacePath?: string | null | undefined;
  readonly branch?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
}

export function normalizeLegacyThreadVcsMetadata(input: LegacyThreadVcsMetadataInput) {
  const refName = input.refName ?? input.branch ?? null;
  const workspacePath = input.workspacePath ?? input.worktreePath ?? null;
  const hasRefKind = input.refKind !== undefined;
  const hasLegacyBranch = input.branch !== undefined;

  return {
    vcsBackend: input.vcsBackend ?? "git",
    refName,
    refKind: hasRefKind ? (input.refKind ?? null) : hasLegacyBranch ? "branch" : null,
    workspacePath,
  } as const;
}
