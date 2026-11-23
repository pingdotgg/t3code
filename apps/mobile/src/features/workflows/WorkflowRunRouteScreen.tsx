import { useAtomValue } from "@effect/atom-react";
import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  readWorkflowQuestion,
  workflowAnswer,
  workflowPausedBeat,
  workflowResultLines,
  workflowRunState,
  type WorkflowBeat,
  type WorkflowRunNode,
} from "@t3tools/client-runtime/workflows";
import { EnvironmentId, ThreadId, type WorkflowQuestion } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { T, Var, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";
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
import {
  Card,
  Facts,
  plain,
  reportFailure,
  useCanOpenThread,
  workflowRunFeedOf,
} from "./WorkflowStepCard";
import { WORKFLOW_TONE_CLASS, WorkflowChip } from "./WorkflowsScreen";
import { WorkflowTimeline } from "./WorkflowTimeline";

export type WorkflowRunParams = {
  readonly environmentId: string;
  readonly runId: string;
};

function QuestionCard(props: {
  readonly environmentId: EnvironmentId;
  readonly question: WorkflowQuestion;
  readonly canAnswer: boolean;
  /** Null where this device cannot open the question's thread. */
  readonly onOpenThread: ((thread: NonNullable<WorkflowBeat["thread"]>) => void) | null;
  /** Under its step in the timeline, which already says that it asks. */
  readonly inline?: boolean;
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
      {props.inline === true ? null : (
        <View className="flex-row items-center gap-2">
          <Text className="font-t3-medium text-xs text-warning-foreground">
            {gt("Needs you", { $context: "workflow run status: it waits on a person" })}
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
      )}
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
        {thread === null || props.onOpenThread === null ? null : (
          <Button
            tone="text"
            label={gt("Ask the agent first")}
            onPress={() => props.onOpenThread?.(thread)}
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
  // Steps already there when the run opens are simply shown; later ones arrive with a fade.
  const [openedAtMs] = useState(() => Date.now());
  // Taken in the handler itself: a second tap can land before the busy state renders.
  const acting = useRef(false);
  const act = async (work: () => Promise<void>) => {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    await work();
    acting.current = false;
    setBusy(false);
  };
  const target = { environmentId, input: { runId: run.runId } };
  const resumeRun = () =>
    act(async () => reportFailure(gt("Could not resume the run"), await resume(target)));
  const cancelRun = () =>
    act(
      () =>
        new Promise<void>((done) =>
          Dialog.alert(
            gt("Cancel this run?"),
            gt("Its agents stop and the run cannot be resumed."),
            [
              { text: gt("Keep it"), style: "cancel", onPress: () => done() },
              {
                text: gt("Cancel run"),
                style: "destructive",
                onPress: () => {
                  void cancel(target).then((result) => {
                    reportFailure(gt("Could not cancel the run"), result);
                    done();
                  });
                },
              },
            ],
            { onDismiss: () => done() },
          ),
        ),
    );
  const canOpenThread = useCanOpenThread(environmentId);
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
  const question = (asked: WorkflowQuestion, inline = false) => (
    <QuestionCard
      inline={inline}
      key={`question:${asked.name}`}
      environmentId={environmentId}
      question={asked}
      canAnswer={canOperate}
      onOpenThread={asked.thread !== null && canOpenThread(asked.thread) ? openThread : null}
    />
  );
  const pausedAt = feed === null ? null : workflowPausedBeat(feed, run.status);
  const pause = (
    <Card tone="failed">
      <Text className="font-t3-medium text-sm text-danger-foreground">
        {gt("Paused", { $context: "workflow run status" })}
      </Text>
      <Text className="text-sm text-foreground">{run.detail ?? gt("A step failed.")}</Text>
      <Text className="text-xs text-foreground-muted">
        {run.retired
          ? gt("It cannot go on until its workflow version is registered again.")
          : run.resumesAt === null
            ? gt("It waits for you to resume it.")
            : gt("It tries again by itself, or resume it now.")}
      </Text>
      <Button
        label={gt("Resume now")}
        tone="primary"
        disabled={busy || !canOperate || run.retired}
        loading={busy}
        onPress={() => void resumeRun()}
      />
    </Card>
  );
  const ended = run.endedAt !== null;
  const resultLines = workflowResultLines(run.result);
  // A result worth showing says more than the last answer it may only repeat.
  const lastAnswer = beats.findLast((beat) => beat.kind === "ask" && beat.status === "completed");
  const answered = lastAnswer === undefined ? null : workflowAnswer(lastAnswer.result);
  const resultSaysMore =
    resultLines.length > 0 &&
    !(resultLines.length === 1 && answered !== null && resultLines[0]?.value === answered.choice);

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
        <>
          <Text className="px-1 text-sm text-foreground-muted">
            {detail.error ?? gt("Loading the run's steps…")}
          </Text>
          {/* What waits on a person comes with the run, not its steps, so it stays answerable. */}
          {run.status === "paused" ? pause : null}
          {node.questions.map((asked) => question(asked))}
        </>
      ) : feed.length === 0 && run.status === "paused" && loose.length === 0 ? (
        // Paused before any step: the pause is all there is to say.
        pause
      ) : (
        <View className="gap-4">
          <WorkflowTimeline
            rows={feed}
            node={node}
            question={questionOf}
            loose={loose}
            renderQuestion={(asked) => question(asked, true)}
            pausedAt={pausedAt}
            pause={pause}
            onOpenStep={openStep}
            openedAtMs={openedAtMs}
          />
          {ended && run.status === "completed" && resultSaysMore ? (
            <View className="gap-2 border-t border-border pt-3">
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
            </View>
          ) : null}
        </View>
      )}
      {!ended && canOperate ? (
        <Button
          tone="text"
          label={gt("Cancel run")}
          disabled={busy}
          onPress={() => void cancelRun()}
        />
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
