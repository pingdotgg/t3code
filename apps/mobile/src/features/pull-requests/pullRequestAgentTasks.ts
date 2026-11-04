import {
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestDetail, PullRequestLinkedThreadsResult } from "@t3tools/contracts";

export type PullRequestAgentTask = "ask" | "explain" | "feedback" | "conflicts" | "watch";

export function pullRequestAgentThread(
  threads: PullRequestLinkedThreadsResult["threads"],
  threadId?: string,
) {
  if (threadId) return threads.find((thread) => thread.id === threadId);
  return threads.length === 1 ? threads[0] : undefined;
}

export function pullRequestAgentPrompt(
  task: PullRequestAgentTask,
  terminology: ChangeRequestTerminology,
): string {
  const { shortLabel, singular } = terminology;
  switch (task) {
    case "ask":
      return "";
    case "explain":
      return `Explain this ${singular}. Read the diff and walk through its purpose, the changes, the risks, and what I should read closely before approving. Do not change any code.`;
    case "feedback":
      return `Address the actionable feedback and failing checks on this ${singular}. Fetch the latest review threads and check results, skip resolved feedback, and verify each finding before changing code. First confirm this thread is on the ${shortLabel}'s branch; if it isn't, prepare the ${shortLabel} in its own worktree. Keep the fixes focused and run the relevant checks.`;
    case "conflicts":
      return `Resolve this ${singular}'s conflicts with its base branch. First confirm this thread is on the ${shortLabel}'s branch; if it isn't, prepare the ${shortLabel} in its own worktree. Bring it up to date using this repository's convention, preserve the intent of both sides, and run the relevant checks before pushing.`;
    case "watch":
      return `Watch this ${singular} for check results, new feedback, and conflicts using T3's pull request watch. End the turn once the watch is armed. When it wakes you, assess what changed and report what needs attention.`;
  }
}

export function pullRequestAgentActions(pr: PullRequestDetail, canWatch: boolean) {
  const { shortLabel } = sourceControlClients.get(pr.provider).changeRequest;
  return [
    {
      task: "ask",
      title: "Ask a question",
      icon: "bubble.left.and.text.bubble.right",
      disabled: false,
    },
    { task: "explain", title: `Explain this ${shortLabel}`, icon: "book", disabled: false },
    {
      task: "feedback",
      title: "Address feedback",
      icon: "wrench.and.screwdriver",
      disabled: pr.state !== "open",
    },
    {
      task: "conflicts",
      title: "Resolve conflicts",
      icon: "arrow.triangle.branch",
      disabled: pr.state !== "open" || pr.mergeability !== "conflicting",
    },
    {
      task: "watch",
      title: `Watch ${shortLabel}`,
      icon: "eye",
      disabled: pr.state !== "open" || !canWatch,
    },
  ] as const;
}

export function appendPullRequestAgentPrompt(
  text: string,
  task: PullRequestAgentTask,
  terminology: ChangeRequestTerminology,
  previousPrompt?: string,
): string {
  const prompt = pullRequestAgentPrompt(task, terminology);
  const kept = !previousPrompt
    ? text
    : text === previousPrompt
      ? ""
      : text.trimEnd().endsWith(`\n\n${previousPrompt}`)
        ? text.trimEnd().slice(0, -(previousPrompt.length + 2))
        : text;
  if (!prompt || kept.trimEnd().endsWith(prompt)) return kept;
  return kept.trim().length ? `${kept.trimEnd()}\n\n${prompt}` : prompt;
}
