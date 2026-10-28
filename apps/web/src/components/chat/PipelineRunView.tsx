import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  availablePipelineActions,
  pipelineFeedingStep,
  pipelineRunStatusLabel,
  pipelineStepStatusLabel,
  stepName,
} from "@t3tools/client-runtime/pipeline-run-presentation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type PipelineRun,
  type PipelineRunStep,
  type PipelineRunStepStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BanIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  SkipForwardIcon,
  SquareIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useEnvironmentQuery } from "../../state/query";
import { useQuietThreadShell } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import { AgentElapsed } from "./AgentElapsed";
import {
  PIPELINE_CHILD_LIVE_STATE_LABEL,
  pipelineChildLiveState,
  pipelineStepModelLabel,
} from "./PipelineRunView.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

const STEP_STATUS_ICON: Record<PipelineRunStepStatus, { Icon: LucideIcon; className: string }> = {
  pending: { Icon: CircleDashedIcon, className: "text-muted-foreground/60" },
  // A static glyph on purpose: a spinning icon would repaint continuously.
  running: { Icon: CircleDotIcon, className: "text-info" },
  completed: { Icon: CheckCircle2Icon, className: "text-success" },
  failed: { Icon: XCircleIcon, className: "text-destructive" },
  stopped: { Icon: SquareIcon, className: "text-warning" },
  skipped: { Icon: SkipForwardIcon, className: "text-muted-foreground" },
  cancelled: { Icon: BanIcon, className: "text-muted-foreground" },
};

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

function useOpenThread(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  return (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };
}

/** The parent thread's body: one subscription per run, scoped to this view. */
export function PipelineRunView(props: {
  readonly environmentId: EnvironmentId;
  readonly runId: PipelineRun["id"];
  readonly cwd: string | undefined;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.pipelineRunLive({
      environmentId: props.environmentId,
      input: { runId: props.runId },
    }),
  );
  const run = query.data?.run ?? null;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="pipeline-run-view">
      <div className="chat-content-lane px-4 py-6 sm:px-0">
        {run === null ? (
          <p className="text-sm text-muted-foreground">
            {query.error ?? "Loading pipeline run..."}
          </p>
        ) : (
          <PipelineRunBody environmentId={props.environmentId} run={run} cwd={props.cwd} />
        )}
      </div>
    </div>
  );
}

function PipelineRunBody(props: {
  readonly environmentId: EnvironmentId;
  readonly run: PipelineRun;
  readonly cwd: string | undefined;
}) {
  const { environmentId, run } = props;
  const actions = availablePipelineActions(run);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const providerEntries = deriveProviderInstanceEntries(providers);
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
  // One command at a time: the run changes shape under every action.
  const [inFlight, setInFlight] = useState<string | null>(null);
  const busy = inFlight !== null;

  const perform = async (
    key: string,
    failureTitle: string,
    execute: () => Promise<{ readonly _tag: string }>,
  ) => {
    if (inFlight !== null) return;
    setInFlight(key);
    try {
      const result = await execute();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result as never)) {
        reportFailure(failureTitle, squashAtomCommandFailure(result as never));
      }
    } finally {
      setInFlight(null);
    }
  };

  const stepAction = { runId: run.id, stepIndex: run.currentStepIndex };
  const currentName = stepName(run, run.currentStepIndex);

  const confirmCancel = async () => {
    if (busy) return;
    const message = `Cancel "${run.definition.name}"?\nThe running step is stopped. You can retry or skip it afterwards.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    await perform("cancel", "Could not cancel pipeline", () =>
      cancelRun({ environmentId, input: { runId: run.id } }),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="min-w-0 truncate text-lg font-semibold text-foreground">
          {run.definition.name}
        </h1>
        <p className="text-sm text-muted-foreground">{pipelineRunStatusLabel(run)}</p>
        {run.error ? (
          <p className="text-sm text-destructive-foreground" role="alert">
            {run.error}
          </p>
        ) : null}
        {actions.continue || actions.retry || actions.skip || actions.cancel ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {actions.continue ? (
              <Button
                size="sm"
                disabled={busy || !canContinue}
                onClick={() =>
                  void perform("continue", "Could not continue pipeline", () =>
                    continueRun({ environmentId, input: stepAction }),
                  )
                }
              >
                Continue
              </Button>
            ) : null}
            {actions.retry ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canRetry}
                onClick={() =>
                  void perform("retry", "Could not retry step", () =>
                    retryStep({ environmentId, input: stepAction }),
                  )
                }
              >
                Retry {currentName}
              </Button>
            ) : null}
            {actions.skip ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canSkip}
                onClick={() =>
                  void perform("skip", "Could not skip step", () =>
                    skipStep({ environmentId, input: stepAction }),
                  )
                }
              >
                Skip {currentName}
              </Button>
            ) : null}
            {actions.cancel ? (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={busy || !canCancel}
                onClick={() => void confirmCancel()}
              >
                Cancel run
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      <section aria-label="Starting prompt" className="flex flex-col items-end gap-1">
        <div className="min-w-0 max-w-[80%] rounded-2xl bg-message px-4 py-3 text-message-foreground">
          <ChatMarkdown
            text={run.input}
            cwd={props.cwd}
            environmentId={environmentId}
            isStreaming={false}
            headingLevelOffset={3}
          />
        </div>
      </section>

      <FeedingNotice environmentId={environmentId} run={run} />

      <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Pipeline steps">
        {run.steps.map((step) => (
          <PipelineStepRow
            key={step.index}
            environmentId={environmentId}
            run={run}
            step={step}
            providerEntries={providerEntries}
            cwd={props.cwd}
            canTogglePauseBefore={
              canSetPause &&
              !busy &&
              step.status === "pending" &&
              actions.canTogglePauseBefore(step.index)
            }
            onPauseBeforeChange={(pauseBefore) =>
              void perform(`pause:${step.index}`, "Could not update pause", () =>
                setPauseBefore({
                  environmentId,
                  input: { runId: run.id, stepId: step.stepId, pauseBefore },
                }),
              )
            }
          />
        ))}
      </ol>
    </div>
  );
}

/** Between steps the run reads `running` with the next step still `pending`. */
function FeedingNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly run: PipelineRun;
}) {
  const feeding = pipelineFeedingStep(props.run);
  const shell = useQuietThreadShell(
    feeding === null ? null : scopeThreadRef(props.environmentId, feeding.childThreadId),
  );
  if (feeding === null) return null;
  const active = pipelineChildLiveState(shell) === "working";
  return (
    <p className="text-sm text-muted-foreground" role="status">
      {active
        ? `Waiting for ${feeding.name} to finish`
        : `Starting ${stepName(props.run, props.run.currentStepIndex)}`}
    </p>
  );
}

function PipelineStepRow(props: {
  readonly environmentId: EnvironmentId;
  readonly run: PipelineRun;
  readonly step: PipelineRunStep;
  readonly providerEntries: ReturnType<typeof deriveProviderInstanceEntries>;
  readonly cwd: string | undefined;
  readonly canTogglePauseBefore: boolean;
  readonly onPauseBeforeChange: (pauseBefore: boolean) => void;
}) {
  const { environmentId, run, step } = props;
  const [outputOpen, setOutputOpen] = useState(false);
  const openThread = useOpenThread(environmentId);
  const definitionStep = run.definition.steps[step.index];
  const shell = useQuietThreadShell(
    step.childThreadId === null ? null : scopeThreadRef(environmentId, step.childThreadId),
  );
  const liveState = pipelineChildLiveState(shell);
  const { Icon, className: iconClassName } = STEP_STATUS_ICON[step.status];
  const model =
    definitionStep === undefined
      ? null
      : pipelineStepModelLabel(definitionStep.modelSelection, props.providerEntries);
  const isCurrent = step.index === run.currentStepIndex && run.status !== "completed";
  const statusLabel = pipelineStepStatusLabel(step);
  const childThreadId = step.childThreadId;

  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-border/60 px-3 py-2.5",
        isCurrent && "border-border bg-card",
      )}
      aria-current={isCurrent ? "step" : undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon aria-hidden className={cn("size-4 shrink-0", iconClassName)} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {stepName(run, step.index)}
        </span>
        {step.attempt > 1 ? (
          <Badge variant="outline" size="sm">
            Attempt {step.attempt}
          </Badge>
        ) : null}
        {liveState === null ? null : (
          <Badge variant={liveState === "working" ? "info" : "warning"} size="sm">
            {PIPELINE_CHILD_LIVE_STATE_LABEL[liveState]}
          </Badge>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">{statusLabel}</span>
        {step.startedAt ? (
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            <AgentElapsed
              agent={{
                status: step.status === "running" ? "running" : "completed",
                startedAt: step.startedAt,
                completedAt: step.completedAt,
              }}
            />
          </span>
        ) : null}
      </div>

      {model === null ? null : (
        <div className="flex min-w-0 items-center gap-2 ps-6 text-xs text-muted-foreground">
          {model.entry ? (
            <ProviderInstanceIcon
              driverKind={model.entry.driverKind}
              displayName={model.entry.displayName}
              accentColor={model.entry.accentColor}
              acpRegistryAgentId={model.entry.acpRegistryAgentId}
              acpRegistryIconUrl={model.entry.acpRegistryIconUrl}
              className="size-3.5 shrink-0"
              iconClassName="size-3.5"
            />
          ) : null}
          <span className="min-w-0 truncate">{model.model}</span>
          {model.effort === null ? null : <span className="shrink-0">{model.effort}</span>}
        </div>
      )}

      {step.error ? (
        <p className="ps-6 text-xs text-destructive-foreground" role="alert">
          {step.error}
        </p>
      ) : null}

      {step.outputPreview ? (
        <div className="ps-4">
          <CollapsibleSectionHeader
            expanded={outputOpen}
            aria-label={`${outputOpen ? "Collapse" : "Expand"} output of ${stepName(run, step.index)}`}
            onClick={() => setOutputOpen((open) => !open)}
          >
            Output
          </CollapsibleSectionHeader>
          {outputOpen ? (
            <div className="px-2 pb-1 text-sm">
              <ChatMarkdown
                text={step.outputPreview}
                cwd={props.cwd}
                environmentId={environmentId}
                isStreaming={false}
                headingLevelOffset={3}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {childThreadId !== null || step.status === "pending" ? (
        <div className="flex items-center justify-between gap-2 ps-6">
          {childThreadId === null ? (
            <span />
          ) : (
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label={`Open thread for ${stepName(run, step.index)}`}
              onClick={() => openThread(childThreadId)}
            >
              <ExternalLinkIcon className="size-3" />
              Open thread
            </Button>
          )}
          {step.status === "pending" ? (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              Pause before
              <Switch
                size="sm"
                checked={step.pauseBefore}
                disabled={!props.canTogglePauseBefore}
                onCheckedChange={(checked) => props.onPauseBeforeChange(checked)}
                aria-label={`Pause before ${stepName(run, step.index)}`}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
