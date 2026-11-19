import { useAtomValue } from "@effect/atom-react";
import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  readWorkflowQuestion,
  workflowAgentSummary,
  workflowAnswer,
  workflowRunNow,
  workflowResultLines,
  workflowRunState,
  type WorkflowBeat,
  type WorkflowRunNode,
} from "@t3tools/client-runtime/workflows";
import { EnvironmentId, ThreadId, type WorkflowQuestion } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { T, Var, useGT, useMessages } from "gt-react-native";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Card, Facts, plain, reportFailure, workflowRunFeedOf } from "./WorkflowStepCard";
import { WORKFLOW_TONE_CLASS, WorkflowChip } from "./WorkflowsScreen";

export type WorkflowRunParams = {
  readonly environmentId: string;
  readonly runId: string;
};

function QuestionCard(props: {
  readonly environmentId: EnvironmentId;
  readonly question: WorkflowQuestion;
  readonly canAnswer: boolean;
  readonly onOpenThread: (thread: NonNullable<WorkflowBeat["thread"]>) => void;
}) {
  const { question } = props;
  const view = readWorkflowQuestion(question);
  const gt = useGT();
  const [busy, setBusy] = useState<string | null>(null);
  const answer = useAtomCommand(serverEnvironment.answerWorkflowQuestion, {
    label: "workflow answer",
    reportFailure: false,
  });
  const choose = async (choice: string) => {
    if (busy !== null) return;
    setBusy(choice);
    const result = await answer({
      environmentId: props.environmentId,
      input: { runId: question.runId, name: question.name, choice },
    });
    setBusy(null);
    reportFailure(gt("Could not send the answer"), result);
  };
  const thread = question.thread;
  return (
    <Card tone="input">
      <View className="flex-row items-center gap-2">
        <Text className="font-t3-medium text-xs text-primary">
          {gt("Input", { $context: "workflow question: the run waits on a person" })}
        </Text>
        <Text className="text-xs text-foreground-muted">
          <T>
            asked{" "}
            <Var>
              <RelativeTime timestamp={question.askedAt} />
            </Var>
          </T>
        </Text>
      </View>
      <Text className="font-t3-medium text-base text-foreground">{view.title}</Text>
      {view.body === null ? null : (
        <Text className="text-sm text-foreground-secondary">{plain(view.body)}</Text>
      )}
      <View className="gap-2 pt-1">
        {view.choices.map((choice, index) => (
          <Button
            key={choice}
            label={choice}
            tone={index === 0 ? "primary" : "secondary"}
            fullWidth
            disabled={!props.canAnswer || (busy !== null && busy !== choice)}
            loading={busy === choice}
            onPress={() => void choose(choice)}
          />
        ))}
        {thread === null ? null : (
          <Button
            tone="text"
            label={gt("Ask the agent first")}
            onPress={() => props.onOpenThread(thread)}
          />
        )}
      </View>
      {props.canAnswer ? null : (
        <Text className="text-xs text-foreground-muted">
          <T>This connection can read runs but not answer them.</T>
        </Text>
      )}
    </Card>
  );
}

/** The straight piece of wire between two parts of the flow. */
function Wire(props: { readonly live?: boolean }) {
  return (
    <View
      className={cn("h-4 w-0.5 self-center", props.live === true ? "bg-primary/50" : "bg-border")}
    />
  );
}

/** One wire becoming several, or several becoming one: the piece above or below one column. */
function Rail(props: { readonly index: number; readonly count: number; readonly join?: boolean }) {
  const bar = (shown: boolean) => (
    <View className={cn("h-0.5 flex-1", shown ? "bg-border" : null)} />
  );
  const across = (
    <View className="flex-row">
      {bar(props.index > 0)}
      {bar(props.index < props.count - 1)}
    </View>
  );
  const down = <View className="h-3 w-0.5 self-center bg-border" />;
  return props.join === true ? (
    <View>
      {down}
      {across}
    </View>
  ) : (
    <View>
      {across}
      {down}
    </View>
  );
}

/** A step in the flow: what it was, how it went in a line, and how long it took. */
function FlowNode(props: {
  readonly beat: WorkflowBeat;
  readonly child: WorkflowRunNode | null;
  /** How long it took, as a share of the longest step. */
  readonly share: number;
  readonly onPress: () => void;
}) {
  const { beat } = props;
  const gt = useGT();
  const m = useMessages();
  const running = beat.status === "running";
  const failed = beat.status === "failed";
  const length = formatDuration(beat.endMs - beat.startMs);
  const said = workflowAgentSummary(beat).said;
  const answer = beat.kind === "ask" ? workflowAnswer(beat.result) : null;
  const line = failed
    ? gt("failed after {duration}", { duration: length })
    : running
      ? beat.kind === "sleep"
        ? gt("sleeping")
        : beat.kind === "agent"
          ? gt("working")
          : gt("under way")
      : beat.kind === "agent" && said !== null
        ? plain(said).trim().split("\n", 1)[0]
        : beat.kind === "ask"
          ? answer === null
            ? gt("nobody answered")
            : gt("Answered {choice}", { choice: answer.choice })
          : beat.kind === "run" && props.child !== null
            ? workflowRunNow(props.child, m)
            : length;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${beat.childRun?.title ?? beat.name}, ${line}`}
      onPress={props.onPress}
      className={cn(
        "gap-0.5 rounded-xl border px-3 py-2 active:opacity-70",
        failed ? "border-danger-border bg-danger/5" : "border-border bg-card",
      )}
    >
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground" numberOfLines={1}>
          {beat.childRun?.title ?? beat.name}
        </Text>
        <Text
          className={cn(
            "text-xs",
            failed
              ? "text-danger-foreground"
              : running
                ? "text-info-foreground"
                : "text-foreground-muted",
          )}
        >
          {running
            ? gt("Working", { $context: "workflow step status" })
            : failed
              ? gt("Failed", { $context: "workflow step status" })
              : length}
        </Text>
      </View>
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {line}
      </Text>
      {running ? null : (
        <View className="mt-1 h-0.5 rounded-full bg-border">
          <View
            className="h-0.5 rounded-full bg-icon-subtle"
            style={{ width: `${Math.max(4, Math.round(props.share * 100))}%` }}
          />
        </View>
      )}
    </Pressable>
  );
}

function RunBody(props: { readonly environmentId: EnvironmentId; readonly node: WorkflowRunNode }) {
  const { environmentId, node } = props;
  const { run } = node;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const gt = useGT();
  const m = useMessages();
  const detail = useEnvironmentQuery(
    serverEnvironment.workflowRun({ environmentId, input: { runId: run.runId } }),
  );
  const canOperate = useAtomValue(
    serverEnvironment.cancelWorkflowRun.permissionAtom(environmentId),
  );
  const resume = useAtomCommand(serverEnvironment.resumeWorkflowRun, {
    label: "workflow resume",
    reportFailure: false,
  });
  const cancel = useAtomCommand(serverEnvironment.cancelWorkflowRun, {
    label: "workflow cancel",
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const target = { environmentId, input: { runId: run.runId } };
  const resumeRun = async () => {
    if (busy) return;
    setBusy(true);
    const result = await resume(target);
    setBusy(false);
    reportFailure(gt("Could not resume the run"), result);
  };
  const cancelRun = () =>
    Dialog.alert(gt("Cancel this run?"), gt("Its agents stop and the run cannot be resumed."), [
      { text: gt("Keep it"), style: "cancel" },
      {
        text: gt("Cancel run"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void cancel(target).then((result) => {
            setBusy(false);
            reportFailure(gt("Could not cancel the run"), result);
          });
        },
      },
    ]);
  const openThread = (thread: NonNullable<WorkflowBeat["thread"]>) =>
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: thread.environmentId ?? environmentId,
        threadId: ThreadId.make(thread.threadId),
      }),
    );
  const openStep = (step: string) =>
    navigation.dispatch(
      StackActions.push("WorkflowStep", { environmentId, runId: run.runId, step }),
    );

  const state = workflowRunState(node, m);
  const steps = detail.data?.steps;
  const feed = steps === undefined ? null : workflowRunFeedOf(node, steps);
  const beats = (feed ?? []).flatMap((row) =>
    row.kind === "quick" ? [] : row.kind === "together" ? row.beats : [row],
  );
  const questionOf = (beat: WorkflowBeat) =>
    beat.kind === "ask" && beat.status === "running"
      ? (node.questions.find((question) => question.name === beat.name) ?? null)
      : null;
  const loose = node.questions.filter(
    (question) => !beats.some((beat) => questionOf(beat) === question),
  );
  const question = (asked: WorkflowQuestion) => (
    <QuestionCard
      key={`question:${asked.name}`}
      environmentId={environmentId}
      question={asked}
      canAnswer={canOperate}
      onOpenThread={openThread}
    />
  );
  const failedAtStep = beats.some((beat) => beat.status === "failed");
  const longestMs = Math.max(1, ...beats.map((beat) => beat.endMs - beat.startMs));
  const pause = (
    <Card tone="failed">
      <Text className="font-t3-medium text-sm text-danger-foreground">
        {gt("Paused", { $context: "workflow run status" })}
      </Text>
      <Text className="text-sm text-foreground">{run.detail ?? gt("A step failed.")}</Text>
      <Text className="text-xs text-foreground-muted">
        {run.resumesAt === null
          ? gt("It waits for you to resume it.")
          : gt("It tries again by itself, or resume it now.")}
      </Text>
      <Button
        label={gt("Resume now")}
        tone="primary"
        disabled={busy || !canOperate}
        loading={busy}
        onPress={() => void resumeRun()}
      />
    </Card>
  );
  // What needs a person is open in the flow. Everything else is a node that opens on a tap.
  const stop = (beat: WorkflowBeat) => {
    const asked = questionOf(beat);
    if (asked !== null) return question(asked);
    if (beat.status === "failed" && run.status === "paused") return pause;
    return (
      <FlowNode
        beat={beat}
        child={node.children.find((child) => child.run.runId === beat.childRun?.runId) ?? null}
        share={(beat.endMs - beat.startMs) / longestMs}
        onPress={() => openStep(beat.name)}
      />
    );
  };
  const ended = run.endedAt !== null;
  const resultLines = workflowResultLines(run.result);

  return (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-3 px-4 pt-3"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      <View className="gap-1 px-1">
        <View className="flex-row items-start gap-3">
          <Text className="min-w-0 flex-1 font-t3-bold text-lg text-foreground">{run.title}</Text>
          <Text className={cn("font-t3-medium text-sm", WORKFLOW_TONE_CLASS[state.tone])}>
            {state.word}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <WorkflowChip name={run.workflow} />
          <Text className="text-xs text-foreground-muted">
            <T>
              <Var>{run.workflow}</Var> · started{" "}
              <Var>
                <RelativeTime timestamp={run.startedAt} />
              </Var>
            </T>
          </Text>
        </View>
      </View>
      {feed === null ? (
        <Text className="px-1 text-sm text-foreground-muted">
          {detail.error ?? gt("Loading the run's steps…")}
        </Text>
      ) : (
        <View>
          <View className="size-2 self-center rounded-full bg-icon-subtle" />
          {feed.map((row) =>
            row.kind === "quick" ? (
              <View key={`quick:${row.steps[0]?.name}`} className="items-center">
                <Wire />
                <Text className="px-6 text-xs text-foreground-muted" numberOfLines={1}>
                  {row.steps.map((step) => step.name).join(" · ")}
                </Text>
              </View>
            ) : row.kind === "together" ? (
              <View key={`together:${row.beats[0]?.name}`}>
                <Wire />
                <Text className="self-center pb-1 text-xs text-foreground-muted">
                  <T>at the same time</T>
                </Text>
                <View className="flex-row">
                  {row.beats.map((beat, index) => (
                    <View key={beat.name} className="min-w-0 flex-1">
                      <Rail index={index} count={row.beats.length} />
                      <View className="px-1">{stop(beat)}</View>
                      <Rail index={index} count={row.beats.length} join />
                    </View>
                  ))}
                </View>
              </View>
            ) : (
              <View key={row.name}>
                <Wire />
                {stop(row)}
              </View>
            ),
          )}
          {loose.map((asked) => (
            <View key={`question:${asked.name}`}>
              <Wire />
              {question(asked)}
            </View>
          ))}
          {run.status === "paused" && !failedAtStep ? (
            <View>
              <Wire />
              {pause}
            </View>
          ) : null}
          <Wire live={!ended} />
          {ended ? (
            <Card>
              <Text className="font-t3-medium text-sm text-foreground">
                {run.status === "completed"
                  ? gt("Finished", { $context: "how a workflow run ended" })
                  : run.status === "stopped"
                    ? gt("Stopped", { $context: "how a workflow run ended" })
                    : run.status === "skipped"
                      ? gt("Skipped", { $context: "how a workflow run ended" })
                      : gt("Cancelled", { $context: "how a workflow run ended" })}
              </Text>
              {run.status !== "completed" && run.detail !== null ? (
                <Text className="text-sm text-foreground-secondary">{run.detail}</Text>
              ) : null}
              <Facts
                facts={resultLines.flatMap((line) =>
                  line.label === null ? [] : [{ label: line.label, value: line.value }],
                )}
              />
              {resultLines
                .filter((line) => line.label === null)
                .map((line) => (
                  <Text key={line.value} className="text-sm text-foreground">
                    {line.value}
                  </Text>
                ))}
            </Card>
          ) : null}
        </View>
      )}
      {!ended && canOperate ? (
        <Button tone="text" label={gt("Cancel run")} disabled={busy} onPress={cancelRun} />
      ) : null}
    </ScreenScrollView>
  );
}

/** One run, read from top to bottom: what each agent said, the question it asks, how it ended. */
export function WorkflowRunRouteScreen({ route }: StaticScreenProps<WorkflowRunParams>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const live = useEnvironmentQuery(serverEnvironment.workflowsLive({ environmentId, input: {} }));
  const snapshot = live.data;
  const gt = useGT();
  const navigation = useNavigation();
  const groups =
    snapshot === null
      ? null
      : groupWorkflowRuns(snapshot.workflows, snapshot.runs, snapshot.questions);
  const node =
    groups === null
      ? undefined
      : allWorkflowRunNodes(groups).find((candidate) => candidate.run.runId === route.params.runId);
  return (
    <View className="flex-1 bg-screen">
      <AppBar
        title={
          node?.run.workflow ?? gt("Run", { $context: "noun, page title for one workflow run" })
        }
        onBack={() => {
          if (navigation.canGoBack()) navigation.goBack();
        }}
      />
      {snapshot === null ? (
        <EmptyState
          variant="plain"
          title={live.error === null ? gt("Loading the run…") : gt("Could not load the run")}
          detail={live.error ?? gt("One moment.")}
        />
      ) : node === undefined ? (
        <EmptyState
          variant="plain"
          title={gt("This run is not in the list")}
          detail={gt("It may be older than the runs this server still lists.")}
        />
      ) : (
        <RunBody key={node.run.runId} environmentId={environmentId} node={node} />
      )}
    </View>
  );
}
