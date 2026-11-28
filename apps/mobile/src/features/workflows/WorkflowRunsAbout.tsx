import {
  allWorkflowRunNodes,
  foldWorkflowRunsAbout,
  groupWorkflowRuns,
  readWorkflowQuestion,
  workflowRunOutcome,
  workflowRunState,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunsAboutInput } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { PullRequestSectionHeading } from "../pull-requests/PullRequestSectionHeading";
import { WORKFLOW_TONE_CLASS, WorkflowStateIcon } from "./WorkflowsScreen";

/** The workflow runs whose subject is `item`, on its own screen; hidden while there are none. */
export function WorkflowRunsAbout(props: {
  readonly environmentId: EnvironmentId;
  readonly item: WorkflowRunsAboutInput;
}) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const [unfolded, setUnfolded] = useState(false);
  const enabled = useServerConfigs().get(props.environmentId)?.settings.workflowsEnabled === true;
  const about = useEnvironmentQuery(
    enabled
      ? serverEnvironment.workflowRunsAbout({
          environmentId: props.environmentId,
          input: props.item,
        })
      : null,
  );
  if (!about.data || about.data.runs.length === 0) return null;
  const workflows = about.data.workflows ?? [];
  const { shown, folded } = foldWorkflowRunsAbout(
    allWorkflowRunNodes(groupWorkflowRuns([], about.data.runs, about.data.questions)),
    workflows,
    about.data.worked ?? null,
  );
  const nodes = unfolded ? [...shown, ...folded] : shown;
  return (
    <View className="gap-2">
      <PullRequestSectionHeading>{gt("Workflow runs")}</PullRequestSectionHeading>
      {nodes.map((node) => {
        const state = workflowRunState(node, m);
        const question = node.questions[0];
        const outcome = workflowRunOutcome(node.run);
        // A workflow with no title of its own is told by its run's title, not its key.
        const name =
          workflows.find((workflow) => workflow.name === node.run.workflow)?.title ??
          node.run.title;
        return (
          <Pressable
            key={node.run.runId}
            accessibilityRole="button"
            accessibilityLabel={`${name}, ${outcome ?? state.word}`}
            onPress={() =>
              navigation.dispatch(
                StackActions.push("WorkflowRun", {
                  environmentId: props.environmentId,
                  runId: node.run.runId,
                }),
              )
            }
            className="flex-row items-center gap-2 rounded-2xl bg-grouped-card p-3 active:opacity-70"
          >
            <WorkflowStateIcon node={node} />
            <View className="min-w-0 flex-1">
              <Text className="text-sm" numberOfLines={2}>
                {name}
              </Text>
              {question === undefined ? null : (
                <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                  {readWorkflowQuestion(question).title}
                </Text>
              )}
            </View>
            {outcome === null ? (
              <Text className={cn("font-t3-medium text-xs", WORKFLOW_TONE_CLASS[state.tone])}>
                {state.word}
              </Text>
            ) : (
              <Text className="max-w-1/2 text-xs text-foreground-muted" numberOfLines={1}>
                {outcome}
              </Text>
            )}
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
          </Pressable>
        );
      })}
      {folded.length === 0 ? null : (
        <Pressable
          accessibilityRole="button"
          className="items-center py-2 active:opacity-60"
          onPress={() => setUnfolded(!unfolded)}
        >
          <Text className="text-xs text-foreground-muted">
            {unfolded
              ? gt("Show fewer")
              : gt("{count} more", {
                  count: folded.length,
                  $context: "workflow runs on an item that did nothing worth reading",
                })}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
