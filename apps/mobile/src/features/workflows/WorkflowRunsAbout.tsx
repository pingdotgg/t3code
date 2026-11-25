import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  readWorkflowQuestion,
  workflowRunState,
  workflowRunsAbout,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { PullRequestSectionHeading } from "../pull-requests/PullRequestSectionHeading";
import { WORKFLOW_TONE_CLASS, WorkflowChip } from "./WorkflowsScreen";

/** The workflow runs about a pull request or issue, on its own screen; hidden while there are none. */
export function WorkflowRunsAbout(props: {
  readonly environmentId: EnvironmentId;
  readonly item: Parameters<typeof workflowRunsAbout>[1];
}) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const enabled = useServerConfigs().get(props.environmentId)?.settings.workflowsEnabled === true;
  const live = useEnvironmentQuery(
    enabled
      ? serverEnvironment.workflowsLive({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const snapshot = live.data;
  if (!snapshot) return null;
  const about = new Set(workflowRunsAbout(snapshot.runs, props.item).map((run) => run.runId));
  if (about.size === 0) return null;
  const nodes = allWorkflowRunNodes(
    groupWorkflowRuns(snapshot.workflows, snapshot.runs, snapshot.questions),
  ).filter((node) => about.has(node.run.runId));
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
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
          </Pressable>
        );
      })}
    </View>
  );
}
