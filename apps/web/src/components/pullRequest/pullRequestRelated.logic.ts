import type { PullRequestDetailView } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "~/lib/openPullRequestLink";

export function relatedPullRequests(
  detail: Pick<PullRequestDetailView, "url" | "body" | "comments" | "timelineEvents">,
) {
  const keyOf = (url: string) => {
    const link = parseChangeRequestUrl(url);
    return link ? link.host + "/" + link.repository + "/" + link.number : null;
  };
  const ownKey = keyOf(detail.url);
  const related = new Map<string, { title: string; url: string; state?: string }>();
  for (const body of [
    detail.body,
    ...detail.comments.map((comment) => comment.body),
    ...(detail.timelineEvents ?? []).map((event) => event.body),
  ]) {
    for (const match of body.matchAll(/https?:\/\/[^\s<>"\x60)\]]+/g)) {
      const url = match[0].replace(/[.,;:]+$/, "");
      const link = parseChangeRequestUrl(url);
      const key = keyOf(url);
      if (link && key && key !== ownKey && !related.has(key)) {
        related.set(key, { title: link.repository + " #" + link.number, url });
      }
    }
  }
  for (const event of detail.timelineEvents ?? []) {
    const reference = event.relatedPullRequest;
    const key = reference ? keyOf(reference.url) : null;
    if (reference && key && key !== ownKey) related.set(key, reference);
  }
  return [...related.values()];
}
