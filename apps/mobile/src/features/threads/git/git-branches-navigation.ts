export function shouldCloseGitBranchesSheetAfterCreate(
  creationMode: "branch" | "stack-step",
  creationResult: unknown,
): boolean {
  return creationMode === "branch" || creationResult !== null;
}
