import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  ThreadId,
  resolveEnvironmentMachineKind,
  type WorkflowQuestion,
  type WorkflowRun,
  type WorkflowStep,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { Link } from "@tanstack/react-router";
import { CornerDownRightIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironment, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  nestWorkflowRuns,
  readWorkflowQuestion,
  workflowRunDetail,
  workflowRunStatusVariant,
} from "./workflowsSettings.logic";

const WORKFLOWS_GUIDE_URL = "https://github.com/pingdotgg/t3code/blob/main/docs/user/workflows.md";

const LINK_CLASS_NAME = "underline underline-offset-2 hover:text-foreground";

// Deeper runs share the last step, so a long chain of invocations cannot push a row off the page.
const RUN_INDENT_CLASS_NAMES = ["", "pl-5", "pl-10", "pl-14"] as const;

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: String(squashAtomCommandFailure(result)),
    }),
  );
}

// Reads the minute tick because the compiler caches a render-time Date.now() on the timestamp.
function RelativeLabel({ value }: { readonly value: string }) {
  const nowMinute = useNowMinute();
  return formatRelativeTimeLabel(value, Date.parse(`${nowMinute}:00.000Z`));
}

export function WorkflowsSettings() {
  const { scope, environments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Workflows" variant="plain">
        {scope.kind === "unavailable" ? (
          <SettingsSection title="Unavailable selection">
            <SettingsRow title={scope.message} />
          </SettingsSection>
        ) : environments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyTitle>No environments available</EmptyTitle>
              <EmptyDescription>Connect an environment to see its workflow runs.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-8">
            {environments.map((environment) => (
              <WorkflowEnvironmentSection
                key={environment.environmentId}
                environment={environment}
                labelled={environments.length > 1}
              />
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function WorkflowEnvironmentSection({
  environment,
  labelled,
}: {
  readonly environment: EnvironmentPresentation;
  readonly labelled: boolean;
}) {
  const { environmentId } = environment;
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const live = useEnvironmentQuery(
    connected ? serverEnvironment.workflowsLive({ environmentId, input: {} }) : null,
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const snapshot = live.data;
  const status = !connected
    ? {
        title: "Environment disconnected",
        description: `Reconnect ${environment.label} to see its workflow runs.`,
      }
    : live.error
      ? { title: "Could not load workflow runs", description: live.error }
      : !snapshot
        ? { title: "Loading workflow runs…" }
        : null;
  return (
    <SettingsSection
      title={environment.label}
      hideTitle={!labelled}
      variant="plain"
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {status ? (
        <SettingsGroup>
          <SettingsRow
            title={status.title}
            description={status.description}
            role={status.description === undefined ? "status" : undefined}
          />
        </SettingsGroup>
      ) : snapshot && snapshot.runs.length === 0 && snapshot.questions.length === 0 ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WorkflowIcon />
            </EmptyMedia>
            <EmptyTitle>No workflow runs</EmptyTitle>
            <EmptyDescription>
              Workflows are off on this server, or none has run yet. Start the server with{" "}
              <code className="font-mono">T3CODE_WORKFLOWS</code> set to a definitions file to turn
              them on.{" "}
              <a
                href={WORKFLOWS_GUIDE_URL}
                target="_blank"
                rel="noreferrer"
                className={LINK_CLASS_NAME}
              >
                Read the guide
              </a>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : snapshot ? (
        <div className="space-y-6">
          {snapshot.questions.length > 0 ? (
            <SettingsSection title="Waiting on you">
              {snapshot.questions.map((question) => (
                <WorkflowQuestionRow
                  key={`${question.runId}:${question.name}`}
                  environmentId={environmentId}
                  question={question}
                  run={snapshot.runs.find((run) => run.runId === question.runId)}
                />
              ))}
            </SettingsSection>
          ) : null}
          {snapshot.runs.length > 0 ? (
            <SettingsSection title="Runs">
              {nestWorkflowRuns(snapshot.runs).map(({ run, depth }) => (
                <WorkflowRunRow
                  key={run.runId}
                  environmentId={environmentId}
                  run={run}
                  depth={depth}
                  selected={run.runId === selectedRunId}
                  onSelect={setSelectedRunId}
                />
              ))}
            </SettingsSection>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  );
}

function WorkflowQuestionRow({
  environmentId,
  question,
  run,
}: {
  readonly environmentId: EnvironmentId;
  readonly question: WorkflowQuestion;
  readonly run: WorkflowRun | undefined;
}) {
  const view = readWorkflowQuestion(question);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const canAnswer = useAtomValue(
    serverEnvironment.answerWorkflowQuestion.permissionAtom(environmentId),
  );
  const answer = useAtomCommand(serverEnvironment.answerWorkflowQuestion, {
    label: "workflow answer",
  });
  const choose = async (choice: string) => {
    if (busy) return;
    setBusy(true);
    const given = reason.trim();
    const result = await answer({
      environmentId,
      input: {
        runId: question.runId,
        name: question.name,
        choice,
        ...(given === "" ? {} : { reason: given }),
      },
    });
    setBusy(false);
    reportFailure("Could not answer the question", result);
  };
  return (
    <SettingsRow
      title={view.title}
      description={
        <>
          {run ? `${run.title} · ${run.workflow}` : question.runId} · asked{" "}
          <RelativeLabel value={question.askedAt} />
        </>
      }
    >
      <div className="space-y-2 pb-2">
        {view.body ? (
          <p className="max-w-2xl text-sm whitespace-pre-wrap break-words text-foreground">
            {view.body}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {view.choices.map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant="outline"
              disabled={busy || !canAnswer}
              onClick={() => void choose(choice)}
            >
              {choice}
            </Button>
          ))}
          <div className="min-w-40 flex-1">
            <Input
              size="sm"
              value={reason}
              disabled={busy || !canAnswer}
              aria-label={`Reason for ${view.title}`}
              placeholder="Reason (optional)"
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </div>
        </div>
      </div>
    </SettingsRow>
  );
}

function WorkflowRunRow({
  environmentId,
  run,
  depth,
  selected,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly run: WorkflowRun;
  readonly depth: number;
  readonly selected: boolean;
  readonly onSelect: (runId: string | null) => void;
}) {
  const detail = workflowRunDetail(run);
  return (
    <div
      className={`px-3 py-2.5 sm:px-4 ${RUN_INDENT_CLASS_NAMES[Math.min(depth, RUN_INDENT_CLASS_NAMES.length - 1)]}`}
    >
      <button
        type="button"
        aria-expanded={selected}
        className="flex w-full flex-col gap-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => onSelect(selected ? null : run.runId)}
      >
        <span className="flex flex-wrap items-center gap-2">
          {run.parentRunId !== null ? (
            <CornerDownRightIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-label="Invoked by another run"
            />
          ) : null}
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{run.title}</span>
          <Badge variant={workflowRunStatusVariant(run.status)}>{run.status}</Badge>
          {run.retired ? <Badge variant="outline">retired</Badge> : null}
        </span>
        <span className="text-xs text-muted-foreground">
          {run.workflow} · <RelativeLabel value={run.updatedAt} />
        </span>
        {detail ? (
          <span className="line-clamp-2 text-xs break-words text-muted-foreground">{detail}</span>
        ) : null}
      </button>
      {selected ? <WorkflowRunDetail environmentId={environmentId} run={run} /> : null}
    </div>
  );
}

function WorkflowRunDetail({
  environmentId,
  run,
}: {
  readonly environmentId: EnvironmentId;
  readonly run: WorkflowRun;
}) {
  const detail = useEnvironmentQuery(
    serverEnvironment.workflowRun({ environmentId, input: { runId: run.runId } }),
  );
  const canResume = useAtomValue(serverEnvironment.resumeWorkflowRun.permissionAtom(environmentId));
  const canCancel = useAtomValue(serverEnvironment.cancelWorkflowRun.permissionAtom(environmentId));
  const resume = useAtomCommand(serverEnvironment.resumeWorkflowRun, { label: "workflow resume" });
  const cancel = useAtomCommand(serverEnvironment.cancelWorkflowRun, { label: "workflow cancel" });
  const [busy, setBusy] = useState(false);
  const target = { environmentId, input: { runId: run.runId } };
  const resumeRun = async () => {
    if (busy) return;
    setBusy(true);
    const result = await resume(target);
    setBusy(false);
    reportFailure("Could not resume the run", result);
  };
  const cancelRun = async () => {
    if (busy) return;
    const confirmed = await (requestConfirmDialog(
      `Cancel ${run.title}? Its agents stop and the run cannot be resumed.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await cancel(target);
    setBusy(false);
    reportFailure("Could not cancel the run", result);
  };
  const steps = detail.data?.steps;
  const ended = run.endedAt !== null;
  return (
    <div className="mt-3 space-y-3">
      {detail.error ? (
        <p className="text-xs text-destructive">{detail.error}</p>
      ) : !steps ? (
        <p className="text-xs text-muted-foreground" role="status">
          Loading steps…
        </p>
      ) : steps.length === 0 ? (
        <p className="text-xs text-muted-foreground">No steps yet.</p>
      ) : (
        <ol aria-label={`Steps of ${run.title}`} className="divide-y divide-border/50">
          {steps.map((step) => (
            <WorkflowStepRow key={step.name} environmentId={environmentId} step={step} />
          ))}
        </ol>
      )}
      {ended && run.result !== null ? (
        <pre
          aria-label={`Result of ${run.title}`}
          className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all"
        >
          {JSON.stringify(run.result, null, 2)}
        </pre>
      ) : null}
      {ended ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {run.status === "paused" ? (
            <Button size="sm" disabled={busy || !canResume} onClick={() => void resumeRun()}>
              Resume
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={busy || !canCancel}
            onClick={() => void cancelRun()}
          >
            Cancel run
          </Button>
        </div>
      )}
    </div>
  );
}

function stepStatusVariant(status: WorkflowStep["status"]) {
  if (status === "failed") return "error";
  if (status === "completed") return "success";
  return "info";
}

function WorkflowStepRow({
  environmentId,
  step,
}: {
  readonly environmentId: EnvironmentId;
  readonly step: WorkflowStep;
}) {
  const tookMs =
    step.endedAt === null ? null : Date.parse(step.endedAt) - Date.parse(step.startedAt);
  return (
    <li className="space-y-1 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-foreground">{step.name}</span>
        <Badge variant="outline">{step.kind}</Badge>
        <Badge variant={stepStatusVariant(step.status)}>{step.status}</Badge>
        {step.attempts > 1 ? <span>{step.attempts} attempts</span> : null}
        <span>
          started <RelativeLabel value={step.startedAt} />
          {tookMs === null ? null : ` · took ${formatDuration(tookMs)}`}
        </span>
        {step.threadId !== null ? (
          <WorkflowStepThread
            // A step that ran elsewhere names the linked environment its thread is in.
            environmentId={
              step.environmentId === null ? environmentId : EnvironmentId.make(step.environmentId)
            }
            threadId={ThreadId.make(step.threadId)}
          />
        ) : null}
      </div>
      {step.detail ? <p className="break-words whitespace-pre-wrap">{step.detail}</p> : null}
    </li>
  );
}

function WorkflowStepThread({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  // This client can only open a thread on an environment it is itself connected to.
  const known = useEnvironment(environmentId) !== null;
  if (!known) return <span>Thread in environment {environmentId}</span>;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(environmentId, threadId))}
      className={LINK_CLASS_NAME}
    >
      Open thread
    </Link>
  );
}
