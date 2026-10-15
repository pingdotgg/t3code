import type { PullRequestDetail } from "@t3tools/contracts";
import { Menu } from "../../components/ui/Menu";
import { PullRequestCardRow } from "./PullRequestControls";
import type { PullRequestAgentTask } from "./pullRequestAgentTasks";
import { usePullRequestAgentActions } from "./usePullRequestAgentActions";
import type { PullRequestParams } from "./usePullRequestDiff";

export function PullRequestAgentRow(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
  readonly task: PullRequestAgentTask;
  readonly title?: string;
}) {
  const agent = usePullRequestAgentActions(props.params, props.pr);
  if (!agent.canAsk) return null;
  const action = agent.menuAction(props.task);
  const row = (
    <PullRequestCardRow
      title={props.title ?? action.title}
      icon="sparkles"
      accessibilityLabel={props.title ?? action.title}
      menu={agent.threads.length > 1}
      onPress={
        action.attributes.disabled || agent.threads.length > 1
          ? undefined
          : () => agent.start(props.task)
      }
    />
  );
  if (agent.threads.length <= 1 || action.attributes.disabled) return row;
  return (
    <Menu
      title={props.title ?? action.title}
      actions={agent.threadActions(props.task)}
      onPressAction={({ nativeEvent }) => agent.select(nativeEvent.event)}
    >
      {row}
    </Menu>
  );
}
