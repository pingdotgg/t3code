import type { PullRequestDetail } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { Menu } from "../../components/ui/Menu";
import { PullRequestCardRow } from "./PullRequestControls";
import { PullRequestGlyph } from "./pullRequestGlyphs";
import { allowedUpdateMethods } from "./pullRequestActions";
import { pullRequestBranchSummary } from "./pullRequestStatus";
import type { PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestAction } from "./usePullRequestAction";
import { usePullRequestAgentActions } from "./usePullRequestAgentActions";

type RowProps = { readonly pr: PullRequestDetail; readonly params: PullRequestParams };

export function PullRequestBranchRow(props: RowProps) {
  const action = usePullRequestAction(props.params, props.pr);
  const agent = usePullRequestAgentActions(props.params, props.pr);
  const gt = useGT();
  const m = useMessages();
  const methods = action.available("update-branch") ? allowedUpdateMethods(props.pr) : [];
  const canResolve =
    agent.canAsk && props.pr.state === "open" && props.pr.mergeability === "conflicting";
  const summary = action.busy ? gt("Updating…") : pullRequestBranchSummary(props.pr, m);
  const clean = props.pr.mergeability === "mergeable";
  const conflicting = props.pr.mergeability === "conflicting";
  const row = (
    <PullRequestCardRow
      title={
        props.pr.mergeability === "conflicting"
          ? gt("Conflicts with {branch}", { branch: props.pr.baseBranch })
          : clean
            ? gt("No conflicts with {branch}", { branch: props.pr.baseBranch })
            : gt("Branch", { $context: "git branch" })
      }
      icon={
        conflicting ? PullRequestGlyph.conflicting : clean ? "checkmark.circle" : "arrow.branch"
      }
      tint={
        conflicting
          ? "accent-danger-foreground"
          : clean
            ? "accent-adaptive-emerald-600-400"
            : undefined
      }
      value={
        conflicting || (clean && props.pr.baseComparison !== "behind" && !action.busy)
          ? undefined
          : summary
      }
      compact
      menu={methods.length > 0 || canResolve}
      accessibilityLabel={gt("Branch, {summary}", { summary })}
    />
  );
  if (!methods.length && !canResolve) return row;
  return (
    <Menu
      title={gt("Branch", { $context: "git branch" })}
      actions={[
        ...(canResolve ? [agent.menuAction("conflicts")] : []),
        ...methods.map((id) => ({
          id,
          title: gt(
            "Update with {method, select, merge {merge} rebase {rebase} other {{method}}}",
            {
              method: id,
            },
          ),
          image: "arrow.up.circle",
        })),
      ]}
      onPressAction={({ nativeEvent }) => {
        const method = methods.find((id) => id === nativeEvent.event);
        if (method) void action.perform("update-branch", method);
        else agent.select(nativeEvent.event);
      }}
    >
      {row}
    </Menu>
  );
}
