import { Platform } from "react-native";
import type { PullRequestDetail } from "@t3tools/contracts";
import {
  pullRequestAgentActions,
  pullRequestAgentThread,
  pullRequestAgentThreadActions,
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
  const chooseThread =
    links.threads.length > 1 || links.threads.some((thread) => thread.settled || thread.archivedAt);
  const threadActions = (task: PullRequestAgentTask) =>
    pullRequestAgentThreadActions(links.threads, task, links.canAsk);
  const menuAction = (task: PullRequestAgentTask) => {
    const action = actions.find((action) => action.task === task);
    const items = threadActions(task);
    // Android supports only one submenu level beneath each helper action.
    const subactions =
      Platform.OS === "android"
        ? items.flatMap(
            (item) =>
              item.subactions?.map((child) => ({
                ...child,
                title: `Settled: ${child.title}`,
              })) ?? [item],
          )
        : items;
    return {
      id: task,
      title: action?.title ?? "Open thread",
      image: action?.icon,
      attributes: { disabled: disabled || !links.canAsk || action?.disabled },
      ...(chooseThread ? { subactions } : {}),
    };
  };
  const select = (event: string) => {
    const action = actions.find(
      (action) => event === action.task || event.startsWith(`${action.task}:`),
    );
    if (action)
      start(action.task, event === action.task ? undefined : event.slice(action.task.length + 1));
  };
  return { ...links, actions, disabled, chooseThread, start, threadActions, menuAction, select };
}
