import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  readWorkflowQuestion,
  workflowRunState,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunsAboutInput } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { Pressable, View } from "react-native";

import { ForwardChevron } from "../../components/ui/ForwardChevron";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { PullRequestSectionHeading } from "../pull-requests/PullRequestSectionHeading";
import { WORKFLOW_TONE_CLASS, WorkflowChip } from "./WorkflowsScreen";

/** The workflow runs whose subject is `item`, on its own screen; hidden while there are none. */
export function WorkflowRunsAbout(props: {
  readonly environmentId: EnvironmentId;
  readonly item: WorkflowRunsAboutInput;
}) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
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
  const nodes = allWorkflowRunNodes(groupWorkflowRuns([], about.data.runs, about.data.questions));
  return (
    <View className="gap-2">
      <PullRequestSectionHeading>{gt("Workflow runs")}</PullRequestSectionHeading>
      {nodes.map((node) => {
        const state = workflowRunState(node, m);
        const question = node.questions[0];
        return (
          <Pressable
            key={node.run.runId}
            accessibilityRole="button"
            accessibilityLabel={`${node.run.title}, ${state.word}`}
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
            <WorkflowChip name={node.run.workflow} />
            <View className="min-w-0 flex-1">
              <Text className="text-sm" numberOfLines={2}>
                {node.run.title}
              </Text>
              {question === undefined ? null : (
                <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                  {readWorkflowQuestion(question).title}
                </Text>
              )}
            </View>
            <Text className={cn("font-t3-medium text-xs", WORKFLOW_TONE_CLASS[state.tone])}>
              {state.word}
            </Text>
            <ForwardChevron size={12} tintColorClassName="accent-icon-muted" />
          </Pressable>
        );
      })}
    </View>
  );
}
