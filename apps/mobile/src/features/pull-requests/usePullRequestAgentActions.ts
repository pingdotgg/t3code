import type { PullRequestDetail } from "@t3tools/contracts";
import {
  pullRequestAgentActions,
  pullRequestAgentThread,
  type PullRequestAgentTask,
} from "./pullRequestAgentTasks";
import type { PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { usePullRequestThreads } from "./usePullRequestThreads";

export function usePullRequestAgentActions(
  params: PullRequestParams,
  pr: PullRequestDetail | null,
  filePath?: string,
) {
  const links = usePullRequestThreads(params, pr, filePath);
  const connected = usePullRequestConnected(params.environmentId);
  const actions = pr ? pullRequestAgentActions(pr, links.canWatch) : [];
  const disabled = links.busy || !pr || (connected && links.isPending && !links.threads.length);
  const start = (task: PullRequestAgentTask, threadId?: string) => {
    if (disabled) return;
    const thread = pullRequestAgentThread(links.threads, threadId);
    if (threadId && threadId !== "new" && !thread) return;
    if (task === "ask" && thread && (!links.canAsk || thread.archivedAt)) {
      links.openThread(thread);
      return;
    }
    if (!links.canAsk || actions.find((action) => action.task === task)?.disabled) return;
    void links.ask(thread?.archivedAt ? undefined : thread, task);
  };
  const threadActions = (task: PullRequestAgentTask) => [
    ...links.threads.map((thread) => ({
      id: `${task}:${thread.id}`,
      title: thread.title,
      subtitle: thread.archivedAt ? "Archived thread" : "Continue thread",
      image: "bubble.left.and.bubble.right",
      attributes: { disabled: task !== "ask" && Boolean(thread.archivedAt) },
    })),
    ...(links.canAsk ? [{ id: `${task}:new`, title: "Start a new thread", image: "plus" }] : []),
  ];
  const menuAction = (task: PullRequestAgentTask) => {
    const action = actions.find((action) => action.task === task);
    return {
      id: task,
      title: action?.title ?? "Open thread",
      image: action?.icon,
      attributes: { disabled: disabled || !links.canAsk || action?.disabled },
      ...(links.threads.length > 1 ? { subactions: threadActions(task) } : {}),
    };
  };
  const select = (event: string) => {
    const action = actions.find(
      (action) => event === action.task || event.startsWith(`${action.task}:`),
    );
    if (action)
      start(action.task, event === action.task ? undefined : event.slice(action.task.length + 1));
  };
  return { ...links, actions, disabled, start, threadActions, menuAction, select };
}
