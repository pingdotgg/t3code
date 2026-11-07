import type { OrchestrationV2AppThread } from "@t3tools/contracts";

export function withPullRequestWatchNote(
  result: string,
  child: Pick<OrchestrationV2AppThread, "pullRequests">,
): string {
  const watched = (child.pullRequests ?? []).flatMap((link) =>
    link.watch === undefined ? [] : [link.url],
  );
  return watched.length === 0
    ? result
    : `${result}\n\nT3 Code: this child still watches ${watched.join(", ")}. Its results after pull request updates arrive as new delegated tasks, so this one is not final.`;
}
