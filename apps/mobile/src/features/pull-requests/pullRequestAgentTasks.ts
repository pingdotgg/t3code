import type { PullRequestDetail, PullRequestLinkedThreadsResult } from "@t3tools/contracts";

export type PullRequestAgentTask = "ask" | "explain" | "feedback" | "conflicts" | "watch";

/** An explicit new-thread choice must never fall back to the single linked thread. */
export function pullRequestAgentThread(
  threads: PullRequestLinkedThreadsResult["threads"],
  threadId?: string,
) {
  if (threadId) return threads.find((thread) => thread.id === threadId);
  return threads.length === 1 ? threads[0] : undefined;
}

/** The PR itself travels as composer context; the field holds the reader's request. */
export function pullRequestAgentPrompt(task: PullRequestAgentTask): string {
  switch (task) {
    case "ask":
      return "";
    case "explain":
      return "Explain this pull request. Read the diff and walk through its purpose, the changes, the risks, and what I should read closely before approving. Do not change any code.";
    case "feedback":
      return "Address the actionable feedback and failing checks on this pull request. Fetch the latest review threads and check results, skip resolved feedback, and verify each finding before changing code. First confirm this thread is on the PR's branch; if it isn't, prepare the PR in its own worktree. Keep the fixes focused and run the relevant checks.";
    case "conflicts":
      return "Resolve this pull request's conflicts with its base branch. First confirm this thread is on the PR's branch; if it isn't, prepare the PR in its own worktree. Bring it up to date using this repository's convention, preserve the intent of both sides, and run the relevant checks before pushing.";
    case "watch":
      return "Watch this pull request for check results, new feedback, and conflicts using T3's pull request watch. End the turn once the watch is armed. When it wakes you, assess what changed and report what needs attention.";
  }
}

export function pullRequestAgentActions(pr: PullRequestDetail, canWatch: boolean) {
  return [
    {
      task: "ask",
      title: "Ask a question",
      icon: "bubble.left.and.text.bubble.right",
      disabled: false,
    },
    { task: "explain", title: "Explain this PR", icon: "book", disabled: false },
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
    { task: "watch", title: "Watch PR", icon: "eye", disabled: pr.state !== "open" || !canWatch },
  ] as const;
}

/** A helper appends to an existing draft without taking away anything the reader wrote. */
export function appendPullRequestAgentPrompt(
  text: string,
  task: PullRequestAgentTask,
  previousPrompt?: string,
): string {
  const prompt = pullRequestAgentPrompt(task);
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
