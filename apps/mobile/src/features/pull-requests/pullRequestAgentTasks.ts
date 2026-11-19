import {
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import { APP_NAME } from "@t3tools/shared/branding";
import type { MenuAction } from "@react-native-menu/menu";
import type { PullRequestDetail, PullRequestLinkedThreadsResult } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";

export type PullRequestAgentTask = "ask" | "explain" | "feedback" | "conflicts" | "watch";

export function pullRequestAgentThread(
  threads: PullRequestLinkedThreadsResult["threads"],
  threadId?: string,
) {
  if (threadId) return threads.find((thread) => thread.id === threadId);
  return threads.length === 1 && !threads[0]?.settled && !threads[0]?.archivedAt
    ? threads[0]
    : undefined;
}

export function pullRequestAgentThreadActions(
  threads: PullRequestLinkedThreadsResult["threads"],
  task: PullRequestAgentTask,
  canAsk: boolean,
  resolve: MessageResolver = m,
): MenuAction[] {
  const active: MenuAction[] = [];
  const settled: MenuAction[] = [];
  for (const thread of threads) {
    const action = {
      id: `${task}:${thread.id}`,
      title: thread.title,
      subtitle: thread.archivedAt
        ? resolve(msg("Archived thread"))
        : thread.settled
          ? resolve(msg("Settled thread"))
          : resolve(msg("Continue thread")),
      image: "bubble.left.and.bubble.right",
      attributes: { disabled: task !== "ask" && Boolean(thread.archivedAt) },
    };
    (thread.settled ? settled : active).push(action);
  }
  return [
    ...(canAsk
      ? [{ id: `${task}:new`, title: resolve(msg("Start a new thread")), image: "plus" }]
      : []),
    ...active,
    ...(settled.length
      ? [{ id: `${task}:settled`, title: resolve(msg("Settled threads")), subactions: settled }]
      : []),
  ];
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
      // oxlint-disable-next-line t3code/no-untranslated-copy -- prompt sent to the agent
      return `Explain this ${singular}. Read the diff and walk through its purpose, the changes, the risks, and what I should read closely before approving. Do not change any code.`;
    case "feedback":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- prompt sent to the agent
      return `Address the actionable feedback and failing checks on this ${singular}. Fetch the latest review threads and check results, skip resolved feedback, and verify each finding before changing code. First confirm this thread is on the ${shortLabel}'s branch; if it isn't, prepare the ${shortLabel} in its own worktree. Keep the fixes focused and run the relevant checks.`;
    case "conflicts":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- prompt sent to the agent
      return `Resolve this ${singular}'s conflicts with its base branch. First confirm this thread is on the ${shortLabel}'s branch; if it isn't, prepare the ${shortLabel} in its own worktree. Bring it up to date using this repository's convention, preserve the intent of both sides, and run the relevant checks before pushing.`;
    case "watch":
      return `Watch this ${singular} for check results, new feedback, and conflicts using ${APP_NAME}'s pull request watch. End the turn once the watch is armed. When it wakes you, assess what changed and report what needs attention.`;
  }
}

export function pullRequestAgentActions(
  pr: PullRequestDetail,
  canWatch: boolean,
  resolve: MessageResolver = m,
) {
  const term = changeRequestTermKind(sourceControlClients.get(pr.provider).changeRequest);
  return [
    {
      task: "ask",
      title: resolve(msg("Ask a question")),
      icon: "bubble.left.and.text.bubble.right",
      disabled: false,
    },
    {
      task: "explain",
      title: resolve(
        msg("Explain this {term, select, mr {MR} cr {change request} other {PR}}", { term }),
      ),
      icon: "book",
      disabled: false,
    },
    {
      task: "feedback",
      title: resolve(msg("Address feedback")),
      icon: "wrench.and.screwdriver",
      disabled: pr.state !== "open",
    },
    {
      task: "conflicts",
      title: resolve(msg("Resolve conflicts")),
      icon: "arrow.triangle.branch",
      disabled: pr.state !== "open" || pr.mergeability !== "conflicting",
    },
    {
      task: "watch",
      title: resolve(msg("Watch {term, select, mr {MR} cr {change request} other {PR}}", { term })),
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
