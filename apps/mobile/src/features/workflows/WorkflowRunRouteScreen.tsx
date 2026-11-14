import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  allWorkflowRunNodes,
  buildWorkflowFeed,
  buildWorkflowTimeline,
  groupWorkflowRuns,
  readWorkflowQuestion,
  workflowAgentSummary,
  workflowAnswer,
  workflowResultLines,
  workflowRunState,
  type WorkflowBeat,
  type WorkflowRunNode,
} from "@t3tools/client-runtime/workflows";
import { EnvironmentId, ThreadId, type WorkflowQuestion } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { WORKFLOW_TONE_CLASS, WorkflowChip } from "./WorkflowsScreen";

export type WorkflowRunParams = {
  readonly environmentId: string;
  readonly runId: string;
};

const SAID_LINES = 8;

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  Dialog.alert(title, String(squashAtomCommandFailure(result)));
}

/** Markdown's emphasis marks, which plain text would show as asterisks and backticks. */
const plain = (text: string) => text.replace(/\*\*|__|`/g, "");

function Card(props: { readonly tone?: "input" | "failed"; readonly children: ReactNode }) {
  return (
    <View
      className={cn(
        "gap-2 rounded-2xl border p-4",
        props.tone === "input"
          ? "border-primary bg-primary/5"
          : props.tone === "failed"
            ? "border-danger-border bg-danger/5"
            : "border-border bg-card",
      )}
    >
      {props.children}
    </View>
  );
}

function Facts(props: {
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}) {
  if (props.facts.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {props.facts.map((fact) => (
        <View key={fact.label} className="flex-row gap-1 rounded-md bg-subtle px-2 py-1">
          <Text className="text-xs text-foreground-muted">{fact.label}</Text>
          <Text className="font-t3-medium text-xs text-foreground">{fact.value}</Text>
        </View>
      ))}
    </View>
  );
}

/** A step that took time or involved someone: an agent, a wait, a sleep, a run it invoked. */
function BeatCard(props: {
  readonly beat: WorkflowBeat;
  readonly onOpenThread: (thread: NonNullable<WorkflowBeat["thread"]>) => void;
  readonly onOpenRun: (runId: string) => void;
}) {
  const { beat } = props;
  const thread = beat.thread;
  const child = beat.childRun;
  const summary = workflowAgentSummary(beat);
  const answer = beat.kind === "ask" ? workflowAnswer(beat.result) : null;
  const running = beat.status === "running";
  if (beat.kind !== "agent" && child === null && answer === null) {
    return (
      <Text className="px-1 text-xs text-foreground-muted">
        {beat.name}
        {running ? " · under way" : beat.status === "failed" ? " · failed" : ""}
        {beat.kind === "sleep" && running && beat.detail !== null ? " · sleeping" : ""}
      </Text>
    );
  }
  return (
    <Card>
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground" numberOfLines={1}>
          {beat.name}
        </Text>
        <Text
          className={cn(
            "text-xs",
            beat.status === "failed" ? "text-danger-foreground" : "text-foreground-muted",
          )}
        >
          {running ? "Working" : beat.status === "failed" ? "Failed" : "Done"}
        </Text>
      </View>
      {answer === null ? null : (
        <Text className="text-sm text-foreground">
          Answered {answer.choice}
          {answer.reason === null ? "" : `: ${answer.reason}`}
        </Text>
      )}
      {child === null ? null : (
        <Text className="text-sm text-foreground-secondary" numberOfLines={2}>
          {child.title}
        </Text>
      )}
      {summary.said === null ? null : (
        <Text className="text-sm text-foreground" numberOfLines={SAID_LINES}>
          {plain(summary.said)}
        </Text>
      )}
      {beat.status === "failed" && beat.detail !== null ? (
        <Text className="text-sm text-danger-foreground">{beat.detail}</Text>
      ) : null}
      {answer === null ? <Facts facts={summary.facts} /> : null}
      {thread === null && child === null ? null : (
        <View className="flex-row gap-2 pt-1">
          {thread === null ? null : (
            <Button
              size="compact"
              label={running ? "Watch live" : "Transcript"}
              onPress={() => props.onOpenThread(thread)}
            />
          )}
          {child === null ? null : (
            <Button size="compact" label="Open run" onPress={() => props.onOpenRun(child.runId)} />
          )}
        </View>
      )}
    </Card>
  );
}

function QuestionCard(props: {
  readonly environmentId: EnvironmentId;
  readonly question: WorkflowQuestion;
  readonly canAnswer: boolean;
  readonly onOpenThread: (thread: NonNullable<WorkflowBeat["thread"]>) => void;
}) {
  const { question } = props;
  const view = readWorkflowQuestion(question);
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
    reportFailure("Could not send the answer", result);
  };
  const thread = question.thread;
  return (
    <Card tone="input">
      <View className="flex-row items-center gap-2">
        <Text className="font-t3-medium text-xs text-primary">Input</Text>
        <Text className="text-xs text-foreground-muted">
          asked <RelativeTime timestamp={question.askedAt} />
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
            label="Ask the agent first"
            onPress={() => props.onOpenThread(thread)}
          />
        )}
      </View>
      {props.canAnswer ? null : (
        <Text className="text-xs text-foreground-muted">
          This connection can read runs but not answer them.
        </Text>
      )}
    </Card>
  );
}

function RunBody(props: { readonly environmentId: EnvironmentId; readonly node: WorkflowRunNode }) {
  const { environmentId, node } = props;
  const { run } = node;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
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
    reportFailure("Could not resume the run", result);
  };
  const cancelRun = () =>
    Dialog.alert("Cancel this run?", "Its agents stop and the run cannot be resumed.", [
      { text: "Keep it", style: "cancel" },
      {
        text: "Cancel run",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void cancel(target).then((result) => {
            setBusy(false);
            reportFailure("Could not cancel the run", result);
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
  const openRun = (runId: string) =>
    navigation.dispatch(StackActions.push("WorkflowRun", { environmentId, runId }));

  const state = workflowRunState(node);
  const steps = detail.data?.steps;
  // The run's own clock: a finished step's times are fixed, and one under way ends at its start
  // until the next answer from the server, which is exact enough for an order of cards.
  const feed =
    steps === undefined
      ? null
      : buildWorkflowFeed(
          buildWorkflowTimeline({
            run,
            steps,
            children: node.children.map((child) => child.run),
            nowMs: Date.parse(run.updatedAt),
          }),
        );
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
  const card = (beat: WorkflowBeat) => {
    const asked = questionOf(beat);
    if (asked !== null) return question(asked);
    return <BeatCard key={beat.name} beat={beat} onOpenThread={openThread} onOpenRun={openRun} />;
  };
  const ended = run.endedAt !== null;
  const resultLines = workflowResultLines(run.result);

  return (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-3 px-4 pt-3"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      <NativeStackScreenOptions options={{ title: run.workflow }} />
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
            {run.workflow} · started <RelativeTime timestamp={run.startedAt} />
          </Text>
        </View>
      </View>
      {run.status === "paused" ? (
        <Card tone="failed">
          <Text className="font-t3-medium text-sm text-danger-foreground">Paused</Text>
          <Text className="text-sm text-foreground">{run.detail ?? "A step failed."}</Text>
          <Text className="text-xs text-foreground-muted">
            {run.resumesAt === null
              ? "It waits for you to resume it."
              : "It tries again by itself, or resume it now."}
          </Text>
          <Button
            label="Resume now"
            tone="primary"
            disabled={busy || !canOperate}
            loading={busy}
            onPress={() => void resumeRun()}
          />
        </Card>
      ) : null}
      {feed === null ? (
        <Text className="px-1 text-sm text-foreground-muted">
          {detail.error ?? "Loading the run's steps…"}
        </Text>
      ) : (
        feed.map((row) =>
          row.kind === "quick" ? (
            <Text
              key={`quick:${row.steps[0]?.name}`}
              className="px-1 text-xs text-foreground-muted"
              numberOfLines={1}
            >
              {row.steps.map((step) => step.name).join(" · ")}
            </Text>
          ) : row.kind === "together" ? (
            <View key={`together:${row.beats[0]?.name}`} className="gap-2">
              <Text className="px-1 text-xs text-foreground-muted">At the same time</Text>
              {row.beats.map(card)}
            </View>
          ) : (
            card(row)
          ),
        )
      )}
      {loose.map(question)}
      {ended ? (
        <Card>
          <Text className="font-t3-medium text-sm text-foreground">
            {run.status === "completed"
              ? "Finished"
              : run.status === "stopped"
                ? "Stopped"
                : "Cancelled"}
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
      ) : canOperate ? (
        <Button tone="text" label="Cancel run" disabled={busy} onPress={cancelRun} />
      ) : null}
    </ScreenScrollView>
  );
}

/** One run, read from top to bottom: what each agent said, the question it asks, how it ended. */
export function WorkflowRunRouteScreen({ route }: StaticScreenProps<WorkflowRunParams>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const live = useEnvironmentQuery(serverEnvironment.workflowsLive({ environmentId, input: {} }));
  const snapshot = live.data;
  if (snapshot === null) {
    return (
      <EmptyState
        variant="plain"
        title={live.error === null ? "Loading the run…" : "Could not load the run"}
        detail={live.error ?? "One moment."}
      />
    );
  }
  const groups = groupWorkflowRuns(snapshot.workflows, snapshot.runs, snapshot.questions);
  const node = allWorkflowRunNodes(groups).find(
    (candidate) => candidate.run.runId === route.params.runId,
  );
  if (node === undefined) {
    return (
      <EmptyState
        variant="plain"
        title="This run is not in the list"
        detail="It may be older than the runs this server still lists."
      />
    );
  }
  return <RunBody key={node.run.runId} environmentId={environmentId} node={node} />;
}
