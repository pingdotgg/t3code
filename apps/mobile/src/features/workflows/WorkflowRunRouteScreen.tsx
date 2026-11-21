import { useAtomValue } from "@effect/atom-react";
import {
  allWorkflowRunNodes,
  groupWorkflowRuns,
  readWorkflowQuestion,
  workflowAgentSummary,
  workflowAnswer,
  workflowPausedBeat,
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
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
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

// Wires are drawn with borders, so a corner is a rounded box and nothing needs measuring.
const WIRE = "border-icon-subtle/40";
// Past two, steps that ran at once no longer fit side by side and hang off a rail instead.
const SIDE_BY_SIDE = 2;

/** The straight piece of wire between two parts of the flow, with a word beside it if it has one. */
function Wire(props: { readonly live?: boolean; readonly label?: string }) {
  return (
    <View className="items-center">
      <View
        className={cn(
          "w-0 border-l-2",
          props.label === undefined ? "h-4" : "h-6",
          props.live === true ? "border-primary" : WIRE,
        )}
      />
      {props.label === undefined ? null : (
        <Text className="absolute top-1 left-1/2 ms-3 text-xs text-foreground-muted">
          {props.label}
        </Text>
      )}
    </View>
  );
}

/** Where one column of a side-by-side fork leaves the wire above it, or rejoins the one below. */
function Elbow(props: { readonly first: boolean; readonly join?: boolean }) {
  const join = props.join === true;
  const turn = (
    <View
      className={cn(
        "h-3 flex-1",
        WIRE,
        join ? "border-b-2" : "border-t-2",
        props.first
          ? cn("border-l-2", join ? "rounded-bl-xl" : "rounded-tl-xl")
          : cn("border-r-2", join ? "rounded-br-xl" : "rounded-tr-xl"),
      )}
    />
  );
  const rest = <View className="flex-1" />;
  return (
    <View className="flex-row">
      {props.first ? rest : turn}
      {props.first ? turn : rest}
    </View>
  );
}

/** Where the wire swings out to the rail that many steps hang off, or back in from it. */
function RailTurn(props: { readonly join?: boolean }) {
  return (
    <View className="w-1/2 ps-3">
      <View
        className={cn(
          "h-3 border-l-2",
          WIRE,
          props.join === true ? "rounded-bl-xl border-b-2" : "rounded-tl-xl border-t-2",
        )}
      />
    </View>
  );
}

/** A step in the flow: a mark for what it is, its name, how it went in a line, and its time. */
function FlowNode(props: {
  readonly beat: WorkflowBeat;
  readonly child: WorkflowRunNode | null;
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
    ? (beat.detail ?? gt("failed"))
    : running
      ? beat.kind === "sleep"
        ? gt("sleeping")
        : beat.kind === "agent"
          ? gt("working")
          : gt("under way")
      : beat.kind === "agent" && said !== null
        ? (plain(said).trim().split("\n", 1)[0] ?? "")
        : beat.kind === "ask"
          ? answer === null
            ? gt("nobody answered")
            : gt("Answered {choice}", { choice: answer.choice })
          : beat.kind === "run" && props.child !== null
            ? workflowRunNow(props.child, m)
            : beat.kind === "sleep"
              ? gt("slept")
              : beat.kind === "wait"
                ? gt("waited")
                : "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${beat.childRun?.title ?? beat.name}, ${line === "" ? length : line}`}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-2.5 rounded-2xl border px-2.5 py-2 active:opacity-70",
        failed
          ? "border-danger-border bg-danger/5"
          : running
            ? "border-primary/40 bg-card"
            : "border-border bg-card",
      )}
    >
      <View
        className={cn(
          "size-7 items-center justify-center rounded-lg",
          failed ? "bg-danger" : running ? "bg-primary/10" : "bg-subtle",
        )}
      >
        <SymbolView
          name={
            failed
              ? "exclamationmark.circle"
              : beat.kind === "agent"
                ? "text.bubble"
                : beat.kind === "ask"
                  ? "questionmark.bubble"
                  : beat.kind === "sleep" || beat.kind === "wait"
                    ? "clock"
                    : beat.kind === "run"
                      ? "arrow.triangle.branch"
                      : "checkmark"
          }
          size={14}
          tintColorClassName={
            failed
              ? "accent-danger-foreground"
              : running
                ? "accent-primary"
                : "accent-foreground-muted"
          }
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1">
        <View className="flex-row items-baseline gap-2">
          <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground" numberOfLines={1}>
            {beat.childRun?.title ?? beat.name}
          </Text>
          {/* The page has no ticking clock, so a step under way shows no time. */}
          {running ? null : <Text className="text-xs text-foreground-muted">{length}</Text>}
        </View>
        {line === "" ? null : (
          <Text
            className={cn("text-xs", failed ? "text-danger-foreground" : "text-foreground-muted")}
            numberOfLines={1}
          >
            {line}
          </Text>
        )}
      </View>
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
  const question = (asked: WorkflowQuestion) => (
    <QuestionCard
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
  // What needs a person is open in the flow. Everything else is a node that opens on a tap.
  const stop = (beat: WorkflowBeat) => {
    const asked = questionOf(beat);
    if (asked !== null) return question(asked);
    const failedHere = beat === pausedAt;
    const flowNode = (
      <FlowNode
        beat={beat}
        child={node.children.find((child) => child.run.runId === beat.childRun?.runId) ?? null}
        onPress={() => openStep(beat.name)}
      />
    );
    // The step stays open to a tap beside the pause, for what it said and its transcript.
    return failedHere ? (
      <View className="gap-2">
        {flowNode}
        {pause}
      </View>
    ) : (
      flowNode
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
        <>
          <Text className="px-1 text-sm text-foreground-muted">
            {detail.error ?? gt("Loading the run's steps…")}
          </Text>
          {/* What waits on a person comes with the run, not its steps, so it stays answerable. */}
          {run.status === "paused" ? pause : null}
          {node.questions.map((asked) => question(asked))}
        </>
      ) : (
        <View>
          <View className={cn("size-2.5 self-center rounded-full border-2", WIRE)} />
          {feed.map((row) =>
            row.kind === "quick" ? (
              <View key={`quick:${row.steps[0]?.name}`} className="items-center">
                <Wire />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={row.steps.map((step) => step.name).join(", ")}
                  hitSlop={8}
                  onPress={() => openStep(row.steps[0]?.name ?? "")}
                  className="max-w-[85%] flex-row items-center gap-1 rounded-full border border-border py-0.5 ps-2 pe-2.5 active:opacity-70"
                >
                  <SymbolView
                    name="checkmark"
                    size={10}
                    tintColorClassName="accent-foreground-muted"
                    type="monochrome"
                  />
                  <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
                    {row.steps.map((step) => step.name).join(" · ")}
                  </Text>
                </Pressable>
              </View>
            ) : row.kind === "together" ? (
              <View key={`together:${row.beats[0]?.name}`}>
                <Wire
                  label={
                    row.beats.length <= SIDE_BY_SIDE
                      ? gt("at the same time")
                      : gt("{count} at the same time", { count: row.beats.length })
                  }
                />
                {row.beats.length <= SIDE_BY_SIDE ? (
                  <View className="flex-row">
                    {row.beats.map((beat, index) => (
                      <View key={beat.name} className="min-w-0 flex-1">
                        <Elbow first={index === 0} />
                        <View className="px-1">{stop(beat)}</View>
                        <Elbow first={index === 0} join />
                      </View>
                    ))}
                  </View>
                ) : (
                  <View>
                    <RailTurn />
                    <View className={cn("ms-3 border-l-2", WIRE)}>
                      {row.beats.map((beat) => (
                        <View key={beat.name} className="flex-row items-center py-1">
                          <View className={cn("w-4 border-t-2", WIRE)} />
                          <View className="min-w-0 flex-1">{stop(beat)}</View>
                        </View>
                      ))}
                    </View>
                    <RailTurn join />
                  </View>
                )}
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
          {run.status === "paused" && pausedAt === null ? (
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
