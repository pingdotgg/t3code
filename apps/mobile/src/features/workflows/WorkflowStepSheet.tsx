import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  workflowResultLines,
} from "@t3tools/client-runtime/workflows";
import { EnvironmentId } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionId } from "../../state/session";
import {
  BeatCard,
  Card,
  Facts,
  useWorkflowThreadOpener,
  workflowRunFeedOf,
} from "./WorkflowStepCard";

export type WorkflowStepParams = {
  readonly environmentId: string;
  readonly runId: string;
  readonly step: string;
};

/** One step of a run, opened from its node in the flow: what it said, its facts, its thread. */
export function WorkflowStepSheet({ route }: StaticScreenProps<WorkflowStepParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const gt = useGT();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const sessionId = useEnvironmentSessionId(environmentId);
  const live = useEnvironmentQuery(serverEnvironment.workflowsLive({ environmentId, input: {} }));
  const detail = useEnvironmentQuery(
    serverEnvironment.workflowRun({ environmentId, input: { runId: route.params.runId } }),
  );
  const node =
    live.data === null
      ? undefined
      : allWorkflowRunNodes(
          groupWorkflowRuns(live.data.workflows, live.data.runs, live.data.questions),
        ).find((candidate) => candidate.run.runId === route.params.runId);
  const steps = detail.data?.steps;
  const feed = node === undefined || steps === undefined ? [] : workflowRunFeedOf(node, steps);
  const beat = feed
    .flatMap((row) => (row.kind === "quick" ? [] : row.kind === "together" ? row.beats : [row]))
    .find((candidate) => candidate.name === route.params.step);
  // A pill of quick steps is opened by its first one, and a step can join a pill once it ends.
  const quick = feed.find(
    (row) => row.kind === "quick" && row.steps.some((step) => step.name === route.params.step),
  );
  const quickSteps = quick?.kind === "quick" ? quick.steps : [];
  // A thread or a run replaces the leaf sheet so workspace back navigation still works.
  const threadOpener = useWorkflowThreadOpener(
    environmentId,
    (thread) => navigation.dispatch(StackActions.replace("Thread", thread)),
    { replace: true },
  );
  const openRun = (runId: string) =>
    navigation.dispatch(StackActions.replace("WorkflowRun", { environmentId, runId }));
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader
        title={
          quickSteps.length > 1
            ? quickSteps.map((step) => step.name).join(" · ")
            : route.params.step
        }
        onClose={() => navigation.goBack()}
      />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-4 pt-2"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {quickSteps.length > 0 ? (
            <Card>
              {quickSteps.map((step) => {
                const lines = workflowResultLines(step.result);
                return (
                  <View key={step.name} className="gap-1">
                    <Text className="font-t3-medium text-sm text-foreground">{step.name}</Text>
                    <Facts
                      facts={lines.flatMap((line) =>
                        line.label === null ? [] : [{ label: line.label, value: line.value }],
                      )}
                    />
                    {lines
                      .filter((line) => line.label === null)
                      .map((line) => (
                        <Text key={line.value} className="text-sm text-foreground-secondary">
                          {line.value}
                        </Text>
                      ))}
                  </View>
                );
              })}
            </Card>
          ) : beat === undefined ? (
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              {detail.error ?? live.error ?? gt("Loading the step…")}
            </Text>
          ) : (
            <BeatCard
              beat={beat}
              sessionId={sessionId}
              onOpenThread={beat.thread === null ? null : threadOpener(beat.thread)}
              onOpenRun={openRun}
            />
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
