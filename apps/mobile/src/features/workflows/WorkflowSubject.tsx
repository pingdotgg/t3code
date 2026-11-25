import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  readWorkflowQuestion,
  workflowReferenceIssue,
  workflowReferenceLabel,
  workflowReferencePullRequest,
  workflowReferenceThreadId,
  workflowRunState,
  workflowRunsAbout,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunSubject } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { PullRequestSectionHeading } from "../pull-requests/PullRequestSectionHeading";
import { useWorkflowThreadOpener } from "./WorkflowStepCard";
import { WORKFLOW_TONE_CLASS, WorkflowChip } from "./WorkflowsScreen";

/** What a subject is called in one line: its label, then its title when that says more. */
export function workflowSubjectLine(subject: WorkflowRunSubject): string {
  const label = workflowReferenceLabel(subject);
  return subject.title === "" || subject.title === label ? label : `${label} ${subject.title}`;
}

/** Opens a run's subject on its own screen, or its web address. Null when it has neither. */
export function useWorkflowSubjectOpener(environmentId: EnvironmentId) {
  const navigation = useNavigation();
  const threadOpener = useWorkflowThreadOpener(environmentId, (thread) =>
    navigation.dispatch(StackActions.push("Thread", thread)),
  );
  return (subject: WorkflowRunSubject): (() => void) | null => {
    const issue = workflowReferenceIssue(subject);
    if (issue !== null) {
      return () =>
        navigation.dispatch(
          StackActions.push("Issue", {
            environmentId,
            projectId: issue.projectId,
            tracker: issue.tracker,
            ...(issue.host === undefined ? {} : { host: issue.host }),
            scope: issue.scope,
            issueKey: issue.key,
          }),
        );
    }
    const pullRequest = workflowReferencePullRequest(subject);
    if (pullRequest !== null) {
      return () =>
        navigation.dispatch(
          StackActions.push("PullRequest", {
            environmentId,
            projectId: pullRequest.projectId,
            repository: pullRequest.repository,
            number: pullRequest.number,
            ...(pullRequest.host === undefined ? {} : { host: pullRequest.host }),
          }),
        );
    }
    const threadId = workflowReferenceThreadId(subject);
    if (threadId !== null) return threadOpener({ threadId, environmentId: null });
    const url = subject.url;
    return url === null ? null : () => void tryOpenExternalUrl(url);
  };
}

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
