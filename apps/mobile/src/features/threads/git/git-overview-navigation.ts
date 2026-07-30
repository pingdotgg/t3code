export function resolveGitOverviewReviewNavigationAction(
  presentation: "sheet" | "inspector",
): "replace" | "navigate" {
  return presentation === "sheet" ? "replace" : "navigate";
}
