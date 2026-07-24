import type { PullRequestMonitorSnapshot } from "../sourceControl/gitHubPullRequestMonitor.ts";
import type { PullRequestMonitorActionableEvent } from "./monitorDiff.ts";
import type { PullRequestMonitorReadiness } from "./readiness.ts";

const excerpt = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 280);

export function formatBlockersSummary(readiness: PullRequestMonitorReadiness): string {
  if (readiness.blockers.length === 0)
    return readiness.label === "ready-to-merge" ? "Ready to merge" : "No known blockers";
  return readiness.blockers
    .map((blocker) => {
      switch (blocker.kind) {
        case "terminal":
          return `PR is ${blocker.state}`;
        case "draft":
          return "PR is a draft";
        case "mergeability":
          return `Mergeability: ${blocker.state}`;
        case "checks-missing":
          return "No check results are available";
        case "check-pending":
          return `${blocker.checkName}: pending`;
        case "check-failed":
          return `${blocker.checkName}: failed`;
        case "changes-requested":
          return `${blocker.reviewer}: changes requested`;
        case "unresolved-thread":
          return `Review thread ${blocker.threadId}: unresolved`;
      }
    })
    .join("\n");
}

function formatEvent(
  event: PullRequestMonitorActionableEvent,
  snapshot: PullRequestMonitorSnapshot,
): string {
  switch (event.kind) {
    case "new-review-comment": {
      const thread = snapshot.reviewThreads.find((item) => item.id === event.threadId);
      const comment = snapshot.issueComments.find((item) => item.id === event.threadId);
      if (thread) {
        const location =
          thread.path === null
            ? ""
            : `, ${thread.path}${thread.line === null ? "" : `:${thread.line}`}`;
        return `- Comment from ${thread.author.login}${location}: ${excerpt(thread.body)}`;
      }
      return comment
        ? `- Comment from ${comment.author.login}: ${excerpt(comment.body)}`
        : `- ${event.edited ? "Updated" : "New"} review comment (${event.threadId})`;
    }
    case "changes-requested-review": {
      const review = snapshot.reviews.find((item) => item.id === event.reviewId);
      return `- ${review?.author.login ?? "Reviewer"} requested changes`;
    }
    case "check-failed": {
      const check = snapshot.checkRuns.find((item) => item.id === event.checkRunId);
      return `- Check ${event.checkName}: ${check?.conclusion ?? "failure"}`;
    }
    case "behind-base":
      return `- PR is behind main${snapshot.behindBaseBy === null ? "" : ` by ${snapshot.behindBaseBy} commit(s)`}`;
  }
}

export function buildWakePrompt(input: {
  readonly prNumber: number;
  readonly wakeCount: number;
  readonly events: ReadonlyArray<PullRequestMonitorActionableEvent>;
  readonly snapshot: PullRequestMonitorSnapshot;
  readonly readiness: PullRequestMonitorReadiness;
}): string {
  return `New activity on PR #${input.prNumber} (monitoring, wake ${input.wakeCount}/10).

${input.events.map((event) => formatEvent(event, input.snapshot)).join("\n")}

Status: ${formatBlockersSummary(input.readiness)}
Head: ${input.snapshot.headSha} (approvals/checks are evaluated against this commit)

Policy:
- Verify bot claims against the source before acting.
- Fix legitimate findings and push.
- Dismiss false positives with a brief reply — never silently ignore or comply.
- For CI failures: compare against main; re-run suspected flakes; if the same real failure repeats, ask the user via a question rather than guessing.
- Rebase if the PR is behind main.
- If the goal has become impossible, say so and ask the user.`;
}
