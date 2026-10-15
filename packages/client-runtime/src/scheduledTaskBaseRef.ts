import type { VcsRef } from "@t3tools/contracts";

/**
 * The base branch a new worktree task starts from when none is chosen. Keeps
 * `main` wherever the repo has it, and only otherwise falls back to the repo's
 * default branch (origin/HEAD), then the checked-out branch, so repositories
 * without `main` still work. Empty while that cannot be told yet.
 */
export function defaultWorktreeBaseRef(
  refs: ReadonlyArray<Pick<VcsRef, "name" | "isDefault" | "current">>,
): string {
  if (refs.some((ref) => ref.name === "main" || ref.name === "origin/main")) return "main";
  return (refs.find((ref) => ref.isDefault) ?? refs.find((ref) => ref.current))?.name ?? "";
}
