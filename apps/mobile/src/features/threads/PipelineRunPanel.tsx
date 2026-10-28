import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PipelineRun, PipelineRunId } from "@t3tools/contracts";
import {
  availablePipelineActions,
  pipelineRunStatusLabel,
  pipelineStepStatusLabel,
} from "@t3tools/client-runtime/pipeline-run-presentation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { formatModelSlugName } from "@t3tools/shared/model";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";

import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { pipelineStepPosition, pipelineStepTone, type PipelineStepTone } from "./pipeline-run-view";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

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

/** Shown in place of the feed and composer on a pipeline run's parent thread. */
export function PipelineRunPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly runId: PipelineRunId;
  /** Space the native header covers when UIKit does not inset the scroll view itself. */
  readonly topInset: number;
  readonly automaticInsets: boolean;
  readonly bottomInset: number;
  readonly contentMaxWidth: number | undefined;
}) {
  const { environmentId } = props;
  const runQuery = useEnvironmentQuery(
    serverEnvironment.pipelineRunLive({ environmentId, input: { runId: props.runId } }),
  );
  const run = runQuery.data?.run ?? null;
  const [promptExpanded, setPromptExpanded] = useState(false);
  const openThread = useOpenLinkedThread();

  const canContinue = useAtomValue(
    serverEnvironment.continuePipelineRun.permissionAtom(environmentId),
  );
  const canRetry = useAtomValue(serverEnvironment.retryPipelineStep.permissionAtom(environmentId));
  const canSkip = useAtomValue(serverEnvironment.skipPipelineStep.permissionAtom(environmentId));
  const canCancel = useAtomValue(serverEnvironment.cancelPipelineRun.permissionAtom(environmentId));
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
  const [busy, setBusy] = useState<string | null>(null);

  const perform = async (
    key: string,
    title: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    if (busy !== null) return;
    setBusy(key);
    try {
      reportFailure(title, await action());
    } finally {
      setBusy(null);
    }
  };

  const content = (() => {
    if (run === null) {
      return (
        <View className="gap-3 px-1 pt-2">
          <Text textRole="body" className="text-foreground-muted">
            {runQuery.error ?? "Loading pipeline…"}
          </Text>
          {runQuery.error !== null ? <Button label="Try again" onPress={runQuery.refresh} /> : null}
        </View>
      );
    }
    const actions = availablePipelineActions(run);
    const stepIndex = run.currentStepIndex;
    const tone = runTone(run);
    return (
      <>
        <View className="gap-3 rounded-[20px] border border-border-subtle bg-card-alt p-4">
          <View className="flex-row items-center justify-between gap-3">
            <Text
              textRole="body"
              className="min-w-0 shrink font-t3-bold text-foreground"
              numberOfLines={2}
            >
              {run.definition.name}
            </Text>
            <StatusPill {...tone} size="compact" />
          </View>
          <Text textRole="footnote" className="text-foreground-secondary">
            {pipelineRunStatusLabel(run)}
          </Text>
          {run.error ? (
            <Text textRole="footnote" className="text-danger-text">
              {run.error}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              promptExpanded ? "Collapse starting prompt" : "Expand starting prompt"
            }
            onPress={() => setPromptExpanded((expanded) => !expanded)}
            className="gap-1 active:opacity-70"
          >
            <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
              Starting prompt
            </Text>
            <Text
              textRole="body"
              className="text-foreground"
              numberOfLines={promptExpanded ? undefined : 6}
              selectable={promptExpanded}
            >
              {run.input}
            </Text>
          </Pressable>
        </View>

        <View className="gap-2">
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
              onOpenThread={(threadId) =>
                openThread({ environmentId: String(environmentId), threadId: String(threadId) })
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
        </View>
      </>
    );
  })();

  const actionBar =
    run === null
      ? null
      : (() => {
          const actions = availablePipelineActions(run);
          const stepIndex = run.currentStepIndex;
          const stepInput = { runId: run.id, stepIndex };
          const stepName = run.definition.steps[stepIndex]?.name ?? `Step ${stepIndex + 1}`;
          const visible = actions.continue || actions.retry || actions.skip || actions.cancel;
          if (!visible) return null;
          return (
            <View
              className="flex-row flex-wrap items-center gap-2 border-t border-border-subtle bg-screen px-4 pt-3"
              style={{ paddingBottom: props.bottomInset + 8 }}
            >
              {actions.continue ? (
                <Button
                  label="Continue"
                  tone="primary"
                  accessibilityHint={`Runs ${stepName}`}
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
                  accessibilityHint={`Runs ${stepName} again`}
                  disabled={!canRetry || busy !== null}
                  loading={busy === "retry"}
                  onPress={() =>
                    void perform("retry", "Could not retry the step", () =>
                      retryStep({ environmentId, input: stepInput }),
                    )
                  }
                />
              ) : null}
              {actions.skip ? (
                <Button
                  label="Skip step"
                  accessibilityHint={`Moves past ${stepName} without running it`}
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
          );
        })();

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior={
          props.automaticInsets && Platform.OS === "ios" ? "automatic" : "never"
        }
        contentContainerClassName="gap-4 px-4 pb-6 self-center w-full"
        contentContainerStyle={{
          maxWidth: props.contentMaxWidth,
          paddingTop: props.automaticInsets && Platform.OS === "ios" ? 12 : props.topInset + 12,
        }}
        showsVerticalScrollIndicator={false}
      >
        {content}
      </ScrollView>
      {actionBar}
    </View>
  );
}

function PipelineStepRow(props: {
  readonly environmentId: EnvironmentId;
  readonly run: PipelineRun;
  readonly step: PipelineRun["steps"][number];
  readonly current: boolean;
  readonly pauseBeforeEditable: boolean;
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
  const childShell = useThreadShell(
    childThreadId === null ? null : { environmentId: props.environmentId, threadId: childThreadId },
  );
  const tone = STEP_TONES[pipelineStepTone(step.status)];
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
  const run = runQuery.data?.run ?? null;
  const position = run === null ? null : pipelineStepPosition(run, props.stepId);
  const label =
    position === null ? "Pipeline" : `Pipeline · step ${position.number}/${position.total}`;

  return (
    <View className="flex-row items-center gap-3 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
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
        <Button
          label="Open pipeline"
          tone="secondary"
          onPress={() =>
            openThread({
              environmentId: String(props.environmentId),
              threadId: String(run.parentThreadId),
            })
          }
        />
      )}
    </View>
  );
}
