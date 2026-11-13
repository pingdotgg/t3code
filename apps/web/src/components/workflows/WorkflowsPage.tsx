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
  type WorkflowQuestion,
  type WorkflowRun,
  type WorkflowStep,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BotIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  CornerDownRightIcon,
  HourglassIcon,
  MessagesSquareIcon,
  MoonIcon,
  SplitIcon,
  WorkflowIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import {
  useConnectedEnvironmentIds,
  useEnvironment,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildWorkflowTimeline,
  allWorkflowRunNodes,
  defaultWorkflowRunId,
  groupWorkflowRuns,
  workflowAnswer,
  workflowTriggerLine,
  readWorkflowQuestion,
  workflowBeatSpan,
  workflowResultLines,
  workflowRunActivity,
  workflowRunStatusVariant,
  type WorkflowBeat,
  type WorkflowQuickSteps,
  type WorkflowRunNode,
  type WorkflowTimeline,
} from "./workflows.logic";

const WORKFLOWS_GUIDE_URL = "https://github.com/pingdotgg/t3code/blob/main/docs/user/workflows.md";
const LINK_CLASS_NAME = "underline underline-offset-2 hover:text-foreground";
// Per workflow: a few say how it has gone lately, the rest are one click away.
const FINISHED_SHOWN = 3;
// An agent that returns a dozen fields has said the gist in the first few.
const RESULT_LINES_SHOWN = 4;

export interface WorkflowsSearch {
  readonly env?: string;
  readonly run?: string;
}

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
function useNowMs(): number {
  return Date.parse(`${useNowMinute()}:00.000Z`);
}

function RelativeLabel({ value }: { readonly value: string }) {
  return formatRelativeTimeLabel(value, useNowMs());
}

export function WorkflowsPage() {
  const search = useSearch({ from: "/_chat/workflows" });
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const connected = environments.filter((environment) =>
    connectedIds.includes(environment.environmentId),
  );
  const asked = search.env === undefined ? null : EnvironmentId.make(search.env);
  const environmentId =
    connected.find((environment) => environment.environmentId === asked)?.environmentId ??
    connected.find((environment) => environment.environmentId === primaryEnvironmentId)
      ?.environmentId ??
    connected[0]?.environmentId ??
    null;
  const select = (next: WorkflowsSearch) =>
    void navigate({ to: "/workflows", search: next, replace: true });

  return (
    <AppRouteModal label="Workflows">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b ps-5 pe-2">
          <h1 className="text-sm font-medium">Workflows</h1>
          {connected.length > 1 && environmentId !== null ? (
            <Select
              value={environmentId}
              onValueChange={(value) => {
                if (value !== null) select({ env: value });
              }}
            >
              <SelectTrigger size="sm" aria-label="Environment">
                <SelectValue>
                  {connected.find((environment) => environment.environmentId === environmentId)
                    ?.label ?? environmentId}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {connected.map((environment) => (
                  <SelectItem key={environment.environmentId} value={environment.environmentId}>
                    {environment.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          <span className="flex-1" />
          <AppRouteModalClose />
        </header>
        {environmentId === null ? (
          <WorkflowsEmpty
            title="No environment connected"
            description="Connect an environment to see its workflow runs."
          />
        ) : (
          <WorkflowsEnvironment
            key={environmentId}
            environmentId={environmentId}
            selectedRunId={search.run ?? null}
            onSelect={(run) =>
              select({
                ...(search.env === undefined ? {} : { env: search.env }),
                ...(run === null ? {} : { run }),
              })
            }
          />
        )}
      </div>
    </AppRouteModal>
  );
}

function WorkflowsEmpty({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WorkflowIcon />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

export function WorkflowsEnvironment({
  environmentId,
  selectedRunId,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly selectedRunId: string | null;
  readonly onSelect: (runId: string | null) => void;
}) {
  const live = useEnvironmentQuery(serverEnvironment.workflowsLive({ environmentId, input: {} }));
  const [opened, setOpened] = useState<ReadonlyArray<string>>([]);
  const snapshot = live.data;
  if (live.error) {
    return <WorkflowsEmpty title="Could not load workflow runs" description={live.error} />;
  }
  if (!snapshot) {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        Loading workflow runs…
      </p>
    );
  }
  if (snapshot.runs.length === 0 && snapshot.workflows.length === 0) {
    return (
      <WorkflowsEmpty
        title="No workflow runs yet"
        description={
          <>
            A workflow ties agents, code, schedules and questions to you into one run that survives
            restarts. Start the server with <code className="font-mono">T3CODE_WORKFLOWS</code> set
            to a definitions file.{" "}
            <a
              href={WORKFLOWS_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className={LINK_CLASS_NAME}
            >
              Read the guide
            </a>
          </>
        }
      />
    );
  }
  const groups = groupWorkflowRuns(snapshot.workflows, snapshot.runs, snapshot.questions);
  const all = allWorkflowRunNodes(groups);
  const shownRunId =
    all.find((node) => node.run.runId === selectedRunId)?.run.runId ?? defaultWorkflowRunId(groups);
  const shown = all.find((node) => node.run.runId === shownRunId) ?? null;
  const rows = (nodes: ReadonlyArray<WorkflowRunNode>) => (
    <ul>
      {nodes.map((node) => (
        <WorkflowRunListItem
          key={node.run.runId}
          node={node}
          depth={0}
          shownRunId={shownRunId}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
  return (
    <div className="flex min-h-0 flex-1">
      {/* Below md there is room for one of the two: the list, or the run picked from it. */}
      <div
        className={cn(
          "min-h-0 w-full shrink-0 flex-col md:w-80 md:border-e",
          selectedRunId === null ? "flex" : "hidden md:flex",
        )}
      >
        <ScrollArea className="min-h-0 flex-1">
          <nav aria-label="Workflow runs" className="space-y-5 p-3">
            {groups.needsYou.length === 0 ? null : (
              <section aria-label="Needs you" className="space-y-1">
                <h2 className="flex items-center gap-2 px-2 text-xs font-medium text-foreground">
                  Needs you
                  <span className="text-muted-foreground tabular-nums">
                    {groups.needsYou.length}
                  </span>
                </h2>
                {rows(groups.needsYou)}
              </section>
            )}
            {groups.workflows.map((section) => {
              // The finished ones are history: a few say how it has gone, the rest wait a click.
              const open = opened.includes(section.name);
              const finished = open ? section.finished : section.finished.slice(0, FINISHED_SHOWN);
              return (
                <section key={section.name} aria-label={section.name} className="space-y-1">
                  <div className="px-2">
                    <h2 className="font-mono text-xs font-medium text-foreground">
                      {section.name}
                    </h2>
                    <p className="text-xs text-muted-foreground">{workflowTriggerLine(section)}</p>
                  </div>
                  {rows(section.active)}
                  {rows(finished)}
                  {section.finished.length > finished.length ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setOpened([...opened, section.name])}
                    >
                      {section.finished.length - finished.length} earlier
                    </Button>
                  ) : null}
                  {section.neverRan ? (
                    <p className="px-2 text-xs text-muted-foreground">Has not run yet.</p>
                  ) : null}
                </section>
              );
            })}
          </nav>
        </ScrollArea>
      </div>
      <ScrollArea
        className={cn(
          "min-h-0 min-w-0 flex-1",
          selectedRunId === null ? "hidden md:block" : "block",
        )}
      >
        {shown === null ? null : (
          <WorkflowRunView
            key={shown.run.runId}
            environmentId={environmentId}
            node={shown}
            parent={all.find((node) => node.run.runId === shown.run.parentRunId)?.run ?? null}
            onSelect={onSelect}
          />
        )}
      </ScrollArea>
    </div>
  );
}

function WorkflowRunListItem({
  node,
  depth,
  shownRunId,
  onSelect,
}: {
  readonly node: WorkflowRunNode;
  readonly depth: number;
  readonly shownRunId: string | null;
  readonly onSelect: (runId: string | null) => void;
}) {
  const { run } = node;
  const activity = workflowRunActivity(run, node.questions.length);
  const shown = run.runId === shownRunId;
  return (
    <li>
      <button
        type="button"
        aria-current={shown ? "true" : undefined}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset",
          shown ? "bg-accent" : "hover:bg-accent/50",
        )}
        onClick={() => onSelect(run.runId)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {depth > 0 ? (
            <CornerDownRightIcon
              aria-label="Invoked by the run above"
              className="size-3 shrink-0 text-muted-foreground"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{run.title}</span>
          <Badge size="sm" variant={workflowRunStatusVariant(run.status)}>
            {node.questions.length > 0 ? "asks you" : run.status}
          </Badge>
        </span>
        <span className="flex min-w-0 gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {activity ?? (depth > 0 ? run.workflow : "")}
          </span>
          <span className="shrink-0">
            <RelativeLabel value={run.updatedAt} />
          </span>
        </span>
      </button>
      {node.children.length > 0 ? (
        <ul className="ms-3">
          {node.children.map((child) => (
            <WorkflowRunListItem
              key={child.run.runId}
              node={child}
              depth={depth + 1}
              shownRunId={shownRunId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function WorkflowRunView({
  environmentId,
  node,
  parent,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: WorkflowRunNode;
  readonly parent: WorkflowRun | null;
  readonly onSelect: (runId: string | null) => void;
}) {
  const { run } = node;
  const nowMs = useNowMs();
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
  const ended = run.endedAt !== null;
  const ranMs = (ended ? Date.parse(run.endedAt) : nowMs) - Date.parse(run.startedAt);
  const steps = detail.data?.steps;
  const timeline =
    steps === undefined
      ? null
      : buildWorkflowTimeline({
          run,
          steps,
          children: node.children.map((child) => child.run),
          nowMs,
        });
  const resultLines = workflowResultLines(run.result);
  return (
    <article aria-label={run.title} className="mx-auto flex max-w-3xl flex-col gap-5 p-5">
      <header className="space-y-2">
        <Button
          size="sm"
          variant="ghost"
          className="md:hidden"
          onClick={() => onSelect(null)}
          aria-label="Back to the list of runs"
        >
          <ArrowLeftIcon />
          Runs
        </Button>
        {parent === null ? null : (
          <button
            type="button"
            className={cn("block cursor-pointer text-xs text-muted-foreground", LINK_CLASS_NAME)}
            onClick={() => onSelect(parent.runId)}
          >
            Part of {parent.title}
          </button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 text-lg font-medium break-words">{run.title}</h2>
          <Badge variant={workflowRunStatusVariant(run.status)}>{run.status}</Badge>
          {run.retired ? <Badge variant="outline">retired</Badge> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {run.workflow} · started <RelativeLabel value={run.startedAt} /> ·{" "}
          {ended ? "took" : "running for"} {formatDuration(ranMs)}
        </p>
      </header>

      {run.status === "paused" ? (
        <section
          aria-label="Why it paused"
          className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/4 p-3"
        >
          <p className="text-sm font-medium">A step failed, so the run is paused there.</p>
          {run.detail ? (
            <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
              {run.detail}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Fix the cause, then resume: only the failed step runs again.
            {run.retired
              ? " Its workflow version is no longer registered, so it cannot go on until that version is back."
              : null}
          </p>
          <Button size="sm" disabled={busy || !canResume} onClick={() => void resumeRun()}>
            Resume
          </Button>
        </section>
      ) : null}

      {node.questions.map((question) => (
        <WorkflowQuestionCard
          key={question.name}
          environmentId={environmentId}
          question={question}
        />
      ))}

      {ended && (resultLines.length > 0 || run.detail) ? (
        <section aria-label="How it ended" className="space-y-1 rounded-lg border p-3">
          <h3 className="text-xs font-medium text-muted-foreground">
            {run.status === "completed"
              ? "Result"
              : `Why it ${run.status === "stopped" ? "stopped" : "was cancelled"}`}
          </h3>
          {run.status !== "completed" && run.detail ? (
            <p className="text-sm break-words whitespace-pre-wrap">{run.detail}</p>
          ) : null}
          {resultLines.map((line) => (
            <p key={line.label ?? line.value} className="text-sm break-words whitespace-pre-wrap">
              {line.label === null ? null : (
                <span className="text-muted-foreground">{line.label}: </span>
              )}
              {line.value}
            </p>
          ))}
        </section>
      ) : null}

      <section aria-label="What happened" className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">What happened</h3>
        {detail.error ? (
          <p className="text-xs text-destructive">{detail.error}</p>
        ) : timeline === null ? (
          <p className="text-xs text-muted-foreground" role="status">
            Loading steps…
          </p>
        ) : timeline.rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing yet.</p>
        ) : (
          <ol className="space-y-1">
            {timeline.rows.map((row) =>
              row.kind === "quick" ? (
                <WorkflowQuickStepsRow key={`quick:${row.steps[0]?.name}`} row={row} />
              ) : (
                <WorkflowBeatRow
                  key={row.name}
                  environmentId={environmentId}
                  beat={row}
                  timeline={timeline}
                  nowMs={nowMs}
                  onSelect={onSelect}
                />
              ),
            )}
          </ol>
        )}
      </section>

      {ended ? null : (
        <footer>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={busy || !canCancel}
            onClick={() => void cancelRun()}
          >
            Cancel run
          </Button>
        </footer>
      )}
    </article>
  );
}

function WorkflowQuestionCard({
  environmentId,
  question,
}: {
  readonly environmentId: EnvironmentId;
  readonly question: WorkflowQuestion;
}) {
  const view = readWorkflowQuestion(question);
  const [reason, setReason] = useState<string | null>(null);
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
    const given = reason?.trim() ?? "";
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
    <section
      aria-label={view.title}
      className="space-y-3 rounded-lg border border-warning/40 bg-warning/4 p-3"
    >
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleHelpIcon className="size-3.5" />
          Asked <RelativeLabel value={question.askedAt} /> · the run waits for your answer
        </p>
        <h3 className="text-sm font-medium break-words">{view.title}</h3>
      </div>
      {view.body ? <ChatMarkdown text={view.body} cwd={undefined} className="text-sm" /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {view.choices.map((choice, index) => (
          <Button
            key={choice}
            size="sm"
            variant={index === 0 ? "default" : "outline"}
            disabled={busy || !canAnswer}
            onClick={() => void choose(choice)}
          >
            {choice}
          </Button>
        ))}
        {reason === null ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReason("")}>
            Add a reason
          </Button>
        ) : null}
        {question.thread === null ? null : (
          <WorkflowThreadLink
            environmentId={environmentId}
            thread={question.thread}
            label="Talk to the agent first"
          />
        )}
      </div>
      {reason === null ? null : (
        <Input
          size="sm"
          autoFocus
          value={reason}
          disabled={busy || !canAnswer}
          aria-label={`Reason for ${view.title}`}
          placeholder="Why, in a sentence. It goes with whichever answer you pick."
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      )}
    </section>
  );
}

const BEAT_ICONS = {
  agent: BotIcon,
  ask: CircleHelpIcon,
  wait: HourglassIcon,
  sleep: MoonIcon,
  run: SplitIcon,
  step: ChevronRightIcon,
} as const;

function beatSummary(beat: WorkflowBeat, nowMs: number): string {
  const under = beat.status === "running";
  const length = formatDuration(beat.endMs - beat.startMs);
  switch (beat.kind) {
    case "agent":
      return under ? `Agent working for ${length}` : `Agent, ${length}`;
    case "ask": {
      if (under) return `Waiting for your answer for ${length}`;
      const answer = workflowAnswer(beat.result);
      return answer === null
        ? `Not answered in ${length}`
        : `Answered “${answer.choice}” after ${length}`;
    }
    case "wait":
      return under ? `Waiting for a signal for ${length}` : `Waited ${length}`;
    case "sleep": {
      const wakes = beat.detail === null ? Number.NaN : Date.parse(beat.detail);
      return under && Number.isFinite(wakes)
        ? wakes > nowMs
          ? `Sleeping, wakes in ${formatDuration(wakes - nowMs)}`
          : "Sleeping, about to wake"
        : `Slept ${length}`;
    }
    case "run":
      return under
        ? `Runs ${beat.childRun?.title ?? beat.name}`
        : `Ran ${beat.childRun?.title ?? beat.name}, ${length}`;
    case "step":
      return under ? `Running for ${length}` : length;
  }
}

function WorkflowBeatRow({
  environmentId,
  beat,
  timeline,
  nowMs,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly beat: WorkflowBeat;
  readonly timeline: WorkflowTimeline;
  readonly nowMs: number;
  readonly onSelect: (runId: string | null) => void;
}) {
  const Icon = BEAT_ICONS[beat.kind];
  const span = workflowBeatSpan(timeline, beat);
  const failed = beat.status === "failed";
  const under = beat.status === "running";
  return (
    <li className="space-y-1 rounded-md px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Icon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            failed ? "text-destructive" : under ? "text-info-foreground" : "text-muted-foreground",
          )}
        />
        <span className="text-sm text-foreground">{beat.name}</span>
        <span className="text-xs text-muted-foreground">{beatSummary(beat, nowMs)}</span>
        {beat.parallel ? (
          <span className="text-xs text-muted-foreground">· side by side</span>
        ) : null}
        {beat.attempts > 1 ? (
          <span className="text-xs text-muted-foreground">· {beat.attempts} tries</span>
        ) : null}
        {failed ? <Badge variant="error">failed</Badge> : null}
        <span className="flex-1" />
        {beat.thread === null ? null : (
          <WorkflowThreadLink
            environmentId={environmentId}
            thread={beat.thread}
            label={under ? "Watch live" : "Transcript"}
          />
        )}
        {beat.childRun === null ? null : (
          <button
            type="button"
            className={cn("cursor-pointer text-xs text-muted-foreground", LINK_CLASS_NAME)}
            onClick={() => onSelect(beat.childRun?.runId ?? null)}
          >
            Open run
          </button>
        )}
      </div>
      {/* Where in the run this was and how much of it: the widths are the run's own time. */}
      <div aria-hidden className="relative h-1 rounded-full bg-muted">
        <div
          className={cn(
            "absolute inset-y-0 rounded-full",
            failed ? "bg-destructive" : under ? "bg-info" : "bg-foreground/40",
          )}
          style={{ left: `${span.offset * 100}%`, width: `${span.length * 100}%` }}
        />
      </div>
      {failed && beat.detail ? (
        <p className="text-xs break-words whitespace-pre-wrap text-destructive">{beat.detail}</p>
      ) : null}
      <WorkflowBeatResult beat={beat} />
    </li>
  );
}

/** What a beat produced, as far as a person wants it in passing; all of it on request. */
function WorkflowBeatResult({ beat }: { readonly beat: WorkflowBeat }) {
  const [open, setOpen] = useState(false);
  if (beat.kind === "ask") {
    const reason = workflowAnswer(beat.result)?.reason ?? null;
    return reason === null ? null : (
      <p className="text-xs break-words text-muted-foreground">Because: {reason}</p>
    );
  }
  // An invoked run's outcome is on the run itself, a click away.
  if (beat.kind === "run") return null;
  const lines = workflowResultLines(beat.result);
  if (lines.length === 0) return null;
  const long = lines.length > RESULT_LINES_SHOWN || lines.some((line) => line.value.length > 240);
  return (
    <div className="space-y-0.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs">
      {(open ? lines : lines.slice(0, RESULT_LINES_SHOWN)).map((line) => (
        <p
          key={line.label ?? line.value}
          className={cn("break-words whitespace-pre-wrap", open ? null : "line-clamp-2")}
        >
          {line.label === null ? null : (
            <span className="text-muted-foreground">{line.label}: </span>
          )}
          {line.value}
        </p>
      ))}
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          className={cn("cursor-pointer text-muted-foreground", LINK_CLASS_NAME)}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : "Show all of it"}
        </button>
      ) : null}
    </div>
  );
}

function WorkflowQuickStepsRow({ row }: { readonly row: WorkflowQuickSteps }) {
  const [open, setOpen] = useState(false);
  const only = row.steps.length === 1 ? row.steps[0] : undefined;
  if (only !== undefined) {
    return (
      <li className="px-2 py-0.5 text-xs text-muted-foreground">
        {only.name}
        <StepTook step={only} />
      </li>
    );
  }
  return (
    <li className="px-2 py-0.5 text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1 hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        <ChevronRightIcon className={cn("size-3", open ? "rotate-90" : null)} />
        {row.steps.length} quick steps · {formatDuration(row.endMs - row.startMs)}
      </button>
      {open ? (
        <ul className="ms-4 mt-1 space-y-0.5">
          {row.steps.map((step) => (
            <li key={step.name}>
              {step.name}
              <StepTook step={step} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function StepTook({ step }: { readonly step: WorkflowStep }) {
  if (step.endedAt === null) return null;
  return ` · ${formatDuration(Date.parse(step.endedAt) - Date.parse(step.startedAt))}`;
}

function WorkflowThreadLink({
  environmentId,
  thread,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: { readonly threadId: string; readonly environmentId: string | null };
  readonly label: string;
}) {
  // A step that ran elsewhere names the linked environment its thread is in.
  const threadEnvironmentId =
    thread.environmentId === null ? environmentId : EnvironmentId.make(thread.environmentId);
  // This client can only open a thread on an environment it is itself connected to.
  const known = useEnvironment(threadEnvironmentId) !== null;
  if (!known) {
    return <span className="text-xs text-muted-foreground">Thread on {threadEnvironmentId}</span>;
  }
  return (
    <Button
      size="sm"
      variant="outline"
      render={
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(
            scopeThreadRef(threadEnvironmentId, ThreadId.make(thread.threadId)),
          )}
        />
      }
    >
      <MessagesSquareIcon />
      {label}
    </Button>
  );
}
