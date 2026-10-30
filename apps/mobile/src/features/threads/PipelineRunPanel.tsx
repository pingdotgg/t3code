import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type {
  EnvironmentId,
  PipelineRun,
  PipelineRunId,
  PipelineRunResult,
} from "@t3tools/contracts";
import {
  availablePipelineActions,
  pipelineRevisionAuthorLabel,
  pipelineRunStateLabel,
  pipelineStepPosition,
  pipelineStepStatusLabel,
  stepName,
} from "@t3tools/client-runtime/pipeline-run-presentation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { formatModelSlugName } from "@t3tools/shared/model";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { formatMessageTime } from "../../lib/time";
import { useQuietThreadShell } from "../../state/entities";
import { threadHasUnseenCompletion } from "./threadListV2";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { pipelineStepTone, stepRevisions, type PipelineStepTone } from "./pipeline-run-view";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

const SYNC_LOCK_MAX_MS = 5_000;

const STEP_TONES: Record<PipelineStepTone, Omit<StatusTone, "label">> = {
  active: { pillClassName: "bg-update", textClassName: "text-update-foreground" },
  success: {
    pillClassName: "bg-adaptive-emerald-500-a12-a16",
    textClassName: "text-adaptive-emerald-700-300",
  },
  danger: { pillClassName: "bg-danger", textClassName: "text-danger-foreground" },
  muted: { pillClassName: "bg-subtle", textClassName: "text-foreground-secondary" },
};

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    Dialog.alert(title, String(squashAtomCommandFailure(result)));
  }
}

function runTone(run: PipelineRun): StatusTone {
  switch (run.status) {
    case "running":
      return { label: "Running", ...STEP_TONES.active };
    case "paused":
      return {
        label: run.pauseReason === "awaiting_continue" ? "Paused" : "Needs attention",
        pillClassName: "bg-warning",
        textClassName: "text-warning-foreground",
      };
    case "completed":
      return { label: "Completed", ...STEP_TONES.success };
    default:
      return { label: "Cancelled", ...STEP_TONES.muted };
  }
}

/** Compact "Step n/N" label for the step the run is at. */
function runProgressLabel(run: PipelineRun): string {
  const total = run.definition.steps.length;
  return `Step ${Math.min(run.currentStepIndex + 1, total)}/${total}`;
}

/**
 * Compact run header for the coordinator sheet: step n/N, name and status. It reads the run
 * without a panel, so the sheet's body stays the coordinator's own chat.
 */
export function PipelineRunSummaryHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly runId: PipelineRunId;
  readonly topInset: number;
  readonly contentMaxWidth: number | undefined;
}) {
  const runQuery = useEnvironmentQuery(
    serverEnvironment.pipelineRunLive({
      environmentId: props.environmentId,
      input: { runId: props.runId },
    }),
  );
  const run = runQuery.data?.run ?? null;
  if (run === null) return <View style={{ paddingTop: props.topInset }} />;
  const tone = runTone(run);
  const stepIndex = Math.min(run.currentStepIndex, run.steps.length - 1);
  return (
    <View
      className="border-b border-border-subtle px-4 pb-2"
      style={{ paddingTop: props.topInset + 4 }}
    >
      <View
        className="w-full flex-row items-center gap-3 self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        <Text numberOfLines={1} className="min-w-0 flex-1 font-t3-medium text-sm text-foreground">
          {runProgressLabel(run)} · {stepName(run, stepIndex)}
        </Text>
        <StatusPill {...tone} size="compact" />
      </View>
    </View>
  );
}

/**
 * Collapsible run overview above a pipeline parent thread's chat (the coordinator). The header
 * and the run actions stay visible; the starting prompt and the steps expand below.
 */
export function PipelineRunPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly runId: PipelineRunId;
  /** Space the native header covers; the feed below is laid out without automatic insets. */
  readonly topInset: number;
  readonly contentMaxWidth: number | undefined;
}) {
  const { environmentId } = props;
  const navigation = useNavigation();
  const { height: windowHeight } = useWindowDimensions();
  const runQuery = useEnvironmentQuery(
    serverEnvironment.pipelineRunLive({ environmentId, input: { runId: props.runId } }),
  );
  const run = runQuery.data?.run ?? null;
  const [expanded, setExpanded] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const openThread = useOpenLinkedThread();

  const canContinue = useAtomValue(
    serverEnvironment.continuePipelineRun.permissionAtom(environmentId),
  );
  const canRetry = useAtomValue(serverEnvironment.retryPipelineStep.permissionAtom(environmentId));
  const canSkip = useAtomValue(serverEnvironment.skipPipelineStep.permissionAtom(environmentId));
  const canCancel = useAtomValue(serverEnvironment.cancelPipelineRun.permissionAtom(environmentId));
  const canRevise = useAtomValue(
    serverEnvironment.revisePipelineStep.permissionAtom(environmentId),
  );
  const canSetPause = useAtomValue(
    serverEnvironment.setPipelineStepPauseBefore.permissionAtom(environmentId),
  );
  const continueRun = useAtomCommand(serverEnvironment.continuePipelineRun, {
    label: "pipeline continue",
    reportFailure: false,
  });
  const retryStep = useAtomCommand(serverEnvironment.retryPipelineStep, {
    label: "pipeline retry step",
    reportFailure: false,
  });
  const skipStep = useAtomCommand(serverEnvironment.skipPipelineStep, {
    label: "pipeline skip step",
    reportFailure: false,
  });
  const cancelRun = useAtomCommand(serverEnvironment.cancelPipelineRun, {
    label: "pipeline cancel",
    reportFailure: false,
  });
  const setPauseBefore = useAtomCommand(serverEnvironment.setPipelineStepPauseBefore, {
    label: "pipeline pause before",
    reportFailure: false,
  });
  // `requestKey` covers the command in flight; `sync` keeps the action locked afterwards until the
  // run subscription shows the run the command returned, so a stale panel cannot act twice.
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [sync, setSync] = useState<{ readonly key: string; readonly updatedAt: string } | null>(
    null,
  );
  const inFlightRef = useRef(false);
  const busy =
    requestKey ??
    (sync !== null && (run === null || run.updatedAt < sync.updatedAt) ? sync.key : null);

  const perform = async (
    key: string,
    title: string,
    action: () => Promise<AtomCommandResult<PipelineRunResult, unknown>>,
  ) => {
    if (inFlightRef.current || busy !== null) return;
    inFlightRef.current = true;
    setRequestKey(key);
    const result = await action().finally(() => {
      inFlightRef.current = false;
      setRequestKey(null);
    });
    reportFailure(title, result);
    if (result._tag === "Success") {
      const updatedAt = result.value.run.updatedAt;
      setSync({ key, updatedAt });
      // A subscription that never catches up must not lock the run for good.
      setTimeout(
        () => setSync((current) => (current?.updatedAt === updatedAt ? null : current)),
        SYNC_LOCK_MAX_MS,
      );
    }
  };

  const wrap = (children: ReactNode) => (
    <View
      className="border-b border-border-subtle px-4 pb-2"
      style={{ paddingTop: props.topInset }}
    >
      <View
        className="w-full gap-2 self-center rounded-[20px] border border-border-subtle bg-card-alt"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {children}
      </View>
    </View>
  );

  if (run === null) {
    return wrap(
      <View className="gap-3 p-4">
        <Text textRole="body" className="text-foreground-muted">
          {runQuery.error ?? "Loading pipeline…"}
        </Text>
        {runQuery.error !== null ? <Button label="Try again" onPress={runQuery.refresh} /> : null}
      </View>,
    );
  }

  const actions = availablePipelineActions(run);
  const stepIndex = run.currentStepIndex;
  const tone = runTone(run);
  const stepInput = { runId: run.id, stepIndex };
  const currentStepName = stepName(run, Math.min(stepIndex, run.steps.length - 1));
  const actionsVisible = actions.continue || actions.retry || actions.skip || actions.cancel;

  return wrap(
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Collapse pipeline steps" : "Expand pipeline steps"}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="gap-1 px-4 pt-3 active:opacity-70"
      >
        <View className="flex-row items-center justify-between gap-3">
          <Text
            textRole="body"
            className="min-w-0 shrink font-t3-bold text-foreground"
            numberOfLines={1}
          >
            {run.definition.name}
          </Text>
          <View className="flex-row items-center gap-2">
            <StatusPill {...tone} size="compact" />
            <SymbolView
              name={expanded ? "chevron.up" : "chevron.down"}
              size={13}
              tintColorClassName="accent-icon-muted"
            />
          </View>
        </View>
        <Text textRole="footnote" className="text-foreground-secondary" numberOfLines={1}>
          {runProgressLabel(run)} · {currentStepName} · {pipelineRunStateLabel(run)}
        </Text>
      </Pressable>
      {run.error ? (
        <Text textRole="footnote" className="px-4 text-danger-text">
          {run.error}
        </Text>
      ) : null}
      {actionsVisible ? (
        <View className="flex-row flex-wrap items-center gap-2 px-4">
          {actions.continue ? (
            <Button
              label="Continue"
              tone="primary"
              accessibilityHint={`Runs ${currentStepName}`}
              disabled={!canContinue || busy !== null}
              loading={busy === "continue"}
              onPress={() =>
                void perform("continue", "Could not continue the pipeline", () =>
                  continueRun({ environmentId, input: stepInput }),
                )
              }
            />
          ) : null}
          {actions.retry ? (
            <Button
              label="Retry step"
              accessibilityHint={`Runs ${currentStepName} again`}
              disabled={!canRetry || busy !== null}
              loading={busy === "retry"}
              onPress={() => {
                const retry = (restoreWorkspace: boolean) =>
                  void perform("retry", "Could not retry the step", () =>
                    retryStep({
                      environmentId,
                      input: restoreWorkspace ? { ...stepInput, restoreWorkspace } : stepInput,
                    }),
                  );
                if (run.steps[stepIndex]?.canRestoreWorkspace !== true) {
                  retry(false);
                  return;
                }
                Dialog.alert(
                  `Retry ${currentStepName}`,
                  "Retry from step start undoes this step's file changes, then runs it again. Commits stay on the branch.",
                  [
                    { text: "Retry from step start", onPress: () => retry(true) },
                    { text: "Retry with current files", onPress: () => retry(false) },
                    { text: "Cancel", style: "cancel" },
                  ],
                );
              }}
            />
          ) : null}
          {actions.skip ? (
            <Button
              label="Skip step"
              accessibilityHint={`Moves past ${currentStepName} without running it`}
              disabled={!canSkip || busy !== null}
              loading={busy === "skip"}
              onPress={() =>
                void perform("skip", "Could not skip the step", () =>
                  skipStep({ environmentId, input: stepInput }),
                )
              }
            />
          ) : null}
          {actions.cancel ? (
            <Button
              label="Cancel run"
              tone="text"
              disabled={!canCancel || busy !== null}
              loading={busy === "cancel"}
              onPress={() =>
                Dialog.confirm({
                  title: "Cancel this pipeline?",
                  message:
                    "The current step is stopped and the remaining steps will not run. Finished steps keep their threads.",
                  confirmText: "Cancel run",
                  cancelText: "Keep running",
                  destructive: true,
                  onConfirm: () =>
                    void perform("cancel", "Could not cancel the pipeline", () =>
                      cancelRun({ environmentId, input: { runId: run.id } }),
                    ),
                })
              }
            />
          ) : null}
        </View>
      ) : null}
      {expanded ? (
        <ScrollView
          nestedScrollEnabled
          style={{ maxHeight: windowHeight * 0.45 }}
          contentContainerClassName="gap-3 px-3 pb-3"
          showsVerticalScrollIndicator={false}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              promptExpanded ? "Collapse starting prompt" : "Expand starting prompt"
            }
            onPress={() => setPromptExpanded((value) => !value)}
            className="gap-1 px-1 active:opacity-70"
          >
            <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
              Starting prompt
            </Text>
            <Text
              textRole="body"
              className="text-foreground"
              numberOfLines={promptExpanded ? undefined : 4}
              selectable={promptExpanded}
            >
              {run.input}
            </Text>
          </Pressable>
          {run.steps.map((step) => (
            <PipelineStepRow
              key={step.stepId}
              environmentId={environmentId}
              run={run}
              step={step}
              current={step.index === stepIndex && run.status !== "completed"}
              pauseBeforeEditable={
                canSetPause && actions.canTogglePauseBefore(step.index) && busy === null
              }
              canSendFeedback={canRevise && actions.revise(step.index)}
              onOpenThread={(threadId) =>
                openThread({ environmentId: String(environmentId), threadId: String(threadId) })
              }
              onSendFeedback={() =>
                navigation.navigate("PipelineFeedback", {
                  environmentId: String(environmentId),
                  runId: String(run.id),
                  stepIndex: step.index,
                })
              }
              onTogglePauseBefore={(pauseBefore) =>
                void perform(`pause:${step.stepId}`, "Could not update the pipeline", () =>
                  setPauseBefore({
                    environmentId,
                    input: { runId: run.id, stepId: step.stepId, pauseBefore },
                  }),
                )
              }
            />
          ))}
        </ScrollView>
      ) : null}
      <View className="h-1" />
    </>,
  );
}

function PipelineStepRow(props: {
  readonly environmentId: EnvironmentId;
  readonly run: PipelineRun;
  readonly step: PipelineRun["steps"][number];
  readonly current: boolean;
  readonly pauseBeforeEditable: boolean;
  readonly canSendFeedback: boolean;
  readonly onSendFeedback: () => void;
  readonly onOpenThread: (
    threadId: NonNullable<PipelineRun["steps"][number]["childThreadId"]>,
  ) => void;
  readonly onTogglePauseBefore: (pauseBefore: boolean) => void;
}) {
  const { run, step } = props;
  const definition = run.definition.steps[step.index];
  const name = definition?.name ?? `Step ${step.index + 1}`;
  const [outputExpanded, setOutputExpanded] = useState(false);
  const childThreadId = step.childThreadId;
  const childShell = useQuietThreadShell(
    childThreadId === null ? null : { environmentId: props.environmentId, threadId: childThreadId },
  );
  const tone = STEP_TONES[pipelineStepTone(step.status)];
  const revisions = stepRevisions(run, step.index);
  const needsInput = childShell?.runtime?.status === "waiting";
  const details = [
    definition ? formatModelSlugName(definition.modelSelection.model) : null,
    step.attempt > 1 ? `Attempt ${step.attempt}` : null,
  ].filter((detail): detail is string => detail !== null);

  const header = (
    <View className="gap-1">
      <View className="flex-row items-center justify-between gap-3">
        <Text
          textRole="body"
          className="min-w-0 shrink font-t3-medium text-foreground"
          numberOfLines={2}
        >
          {step.index + 1}. {name}
        </Text>
        <StatusPill label={pipelineStepStatusLabel(step)} {...tone} size="compact" />
      </View>
      {details.length > 0 ? (
        <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
          {details.join(" · ")}
        </Text>
      ) : null}
      {needsInput ? (
        <Text textRole="footnote" className="text-warning-text">
          Waiting for your input in this step
        </Text>
      ) : null}
    </View>
  );

  return (
    <View
      className={
        props.current
          ? "gap-3 rounded-[20px] border border-border bg-card-alt p-4"
          : "gap-3 rounded-[20px] border border-border-subtle bg-card-alt p-4"
      }
    >
      {childThreadId === null ? (
        header
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${name} thread`}
          onPress={() => props.onOpenThread(childThreadId)}
          className="flex-row items-center gap-2 active:opacity-70"
        >
          <View className="min-w-0 flex-1">{header}</View>
          <SymbolView name="chevron.right" size={14} tintColorClassName="accent-icon-muted" />
        </Pressable>
      )}
      {step.error ? (
        <Text textRole="footnote" className="text-danger-text" selectable>
          {step.error}
        </Text>
      ) : null}
      {step.outputPreview ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={outputExpanded ? "Collapse output" : "Expand output"}
          onPress={() => setOutputExpanded((expanded) => !expanded)}
          className="gap-1 active:opacity-70"
        >
          <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
            {outputExpanded ? "Output" : "Output preview"}
          </Text>
          <Text
            textRole="footnote"
            className="text-foreground-secondary"
            numberOfLines={outputExpanded ? undefined : 4}
            selectable={outputExpanded}
          >
            {step.outputPreview}
          </Text>
        </Pressable>
      ) : null}
      {revisions.length > 0 ? (
        <View className="gap-2">
          <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
            Feedback
          </Text>
          {revisions.map((revision) => (
            <View
              key={`${revision.createdAt}:${revision.author}`}
              className="gap-1 border-l-2 border-border pl-3"
            >
              <Text textRole="footnote" className="font-t3-medium text-foreground-secondary">
                {pipelineRevisionAuthorLabel(revision.author)} ·{" "}
                {formatMessageTime(revision.createdAt)}
              </Text>
              {revision.quote ? (
                <Text textRole="footnote" className="text-foreground-muted" numberOfLines={2}>
                  “{revision.quote}”
                </Text>
              ) : null}
              <Text textRole="footnote" className="text-foreground-secondary" selectable>
                {revision.feedback}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {props.canSendFeedback ? (
        <View className="flex-row">
          <Button
            label="Send feedback"
            tone="secondary"
            icon="text.bubble"
            accessibilityHint={`Later steps redo their work after ${name}`}
            onPress={props.onSendFeedback}
          />
        </View>
      ) : null}
      {props.pauseBeforeEditable || step.pauseBefore ? (
        <View className="flex-row items-center justify-between gap-3">
          <Text textRole="footnote" className="text-foreground-secondary">
            Pause before this step
          </Text>
          <ThemedSwitch
            accessibilityLabel={`Pause before ${name}`}
            value={step.pauseBefore}
            disabled={!props.pauseBeforeEditable}
            onValueChange={props.onTogglePauseBefore}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Shown above a step thread's composer: names its place in the run and links to the parent. */
export function PipelineStepParentBar(props: {
  readonly environmentId: EnvironmentId;
  readonly runId: PipelineRunId;
  readonly stepId: string;
}) {
  const runQuery = useEnvironmentQuery(
    serverEnvironment.pipelineRunLive({
      environmentId: props.environmentId,
      input: { runId: props.runId },
    }),
  );
  const openThread = useOpenLinkedThread();
  const navigation = useNavigation();
  const run = runQuery.data?.run ?? null;
  const parentShell = useQuietThreadShell(
    run === null ? null : { environmentId: props.environmentId, threadId: run.parentThreadId },
  );
  const coordinatorUnread = parentShell !== null && threadHasUnseenCompletion(parentShell);
  const position = run === null ? null : pipelineStepPosition(run, props.stepId);
  const label =
    position === null ? "Pipeline" : `Pipeline · step ${position.number}/${position.total}`;

  return (
    <View className="flex-row items-center gap-2 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
      <View accessible accessibilityLabel={label} className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="font-t3-bold text-sm text-foreground">
          {label}
        </Text>
        {position === null ? null : (
          <Text numberOfLines={1} className="font-sans text-xs text-foreground-secondary">
            {position.name}
          </Text>
        )}
      </View>
      {run === null ? null : (
        <>
          <View>
            <Button
              label="Coordinator"
              tone="secondary"
              accessibilityHint={
                coordinatorUnread ? "The coordinator replied" : "Chat with the pipeline coordinator"
              }
              onPress={() =>
                navigation.navigate("PipelineCoordinator", {
                  environmentId: String(props.environmentId),
                  threadId: String(run.parentThreadId),
                })
              }
            />
            {coordinatorUnread ? (
              <View
                pointerEvents="none"
                accessibilityElementsHidden
                className="absolute right-0 top-0 size-2.5 rounded-full bg-update"
              />
            ) : null}
          </View>
          <Button
            label="Open"
            tone="text"
            accessibilityLabel="Open pipeline"
            onPress={() =>
              openThread({
                environmentId: String(props.environmentId),
                threadId: String(run.parentThreadId),
              })
            }
          />
        </>
      )}
    </View>
  );
}
