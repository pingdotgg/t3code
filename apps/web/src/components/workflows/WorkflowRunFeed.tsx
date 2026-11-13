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
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  HourglassIcon,
  MoonIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironment, useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildWorkflowFeed,
  buildWorkflowTimeline,
  readWorkflowQuestion,
  workflowAgentSummary,
  workflowAnswer,
  workflowChip,
  workflowPath,
  workflowResultLines,
  workflowRunNow,
  workflowRunState,
  workflowSaidStart,
  type WorkflowBeat,
  type WorkflowPathNode,
  type WorkflowQuickSteps,
  type WorkflowRunNode,
  type WorkflowRunTone,
} from "./workflows.logic";

/** An agent's thread, as a step names it: the linked environment it is in, or null for this one. */
export interface WorkflowThreadTarget {
  readonly threadId: string;
  readonly environmentId: string | null;
}

// An agent that wrote a page gets a few lines of it; the rest is a click away.
const SAID_SHOWN = 320;

// What waits on a person is what they came for, so it is in view when the run opens.
const revealOnMount = (element: HTMLElement | null) => {
  element?.scrollIntoView({ block: "nearest" });
};

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

export function RelativeLabel({ value }: { readonly value: string }) {
  return formatRelativeTimeLabel(value, useNowMs());
}

const CHIP_TONES = [
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
] as const;

/** Which workflow a run is of, at a glance: the same letters and colour wherever it shows. */
export function WorkflowChip({ name }: { readonly name: string }) {
  const chip = workflowChip(name);
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-sm text-4xs leading-none font-bold",
        CHIP_TONES[chip.tone],
      )}
    >
      {chip.letters}
    </span>
  );
}

// The thread list's own colours for the same states, so a run reads like a thread does.
export const WORKFLOW_TONE_CLASS: Record<WorkflowRunTone, string> = {
  input: "text-primary",
  failed: "text-destructive",
  working: "text-info-foreground",
  quiet: "text-muted-foreground",
  done: "text-success-foreground",
};

export function WorkflowStateWord({ node }: { readonly node: WorkflowRunNode }) {
  const state = workflowRunState(node);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs font-medium whitespace-nowrap",
        WORKFLOW_TONE_CLASS[state.tone],
      )}
    >
      {state.tone === "working" ? (
        <span aria-hidden className="size-1.5 rounded-full bg-info" />
      ) : state.tone === "done" ? (
        <CheckIcon aria-hidden className="size-3" />
      ) : null}
      {state.word}
    </span>
  );
}

const ordinal = (count: number) =>
  count === 1 ? "1st" : count === 2 ? "2nd" : count === 3 ? "3rd" : `${count}th`;

export function WorkflowRunFeed({
  environmentId,
  node,
  parent,
  openThreadId,
  onSelect,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: WorkflowRunNode;
  readonly parent: WorkflowRun | null;
  /** The thread shown beside the run, so its card can say so. */
  readonly openThreadId: string | null;
  readonly onSelect: (runId: string | null) => void;
  readonly onOpenThread: (thread: WorkflowThreadTarget) => void;
}) {
  const { run } = node;
  const nowMs = useNowMs();
  const article = useRef<HTMLElement | null>(null);
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
  const feed =
    steps === undefined
      ? null
      : buildWorkflowFeed(
          buildWorkflowTimeline({
            run,
            steps,
            children: node.children.map((child) => child.run),
            nowMs,
          }),
        );
  const path = feed === null ? [] : workflowPath(feed);
  const beats = (feed ?? []).flatMap((row) =>
    row.kind === "quick" ? [] : row.kind === "together" ? row.beats : [row],
  );
  // A question is told where it was asked. One whose step is not in the list yet still shows.
  const questionOf = (beat: WorkflowBeat) =>
    beat.kind === "ask" && beat.status === "running"
      ? (node.questions.find((question) => question.name === beat.name) ?? null)
      : null;
  const loose = node.questions.filter(
    (question) => !beats.some((beat) => questionOf(beat) === question),
  );
  const failedAtStep = beats.some((beat) => beat.status === "failed");
  const pause = (name: string | null, attempts: number, reason: string | null) => (
    <WorkflowPauseCard
      run={run}
      name={name}
      attempts={attempts}
      reason={reason}
      nowMs={nowMs}
      disabled={busy || !canResume}
      onResume={() => void resumeRun()}
    />
  );
  const beatCard = (beat: WorkflowBeat) => {
    if (beat.status === "failed" && run.status === "paused") {
      return pause(beat.name, beat.attempts, beat.detail ?? run.detail);
    }
    const question = questionOf(beat);
    if (question !== null) {
      return (
        <WorkflowQuestionCard
          environmentId={environmentId}
          question={question}
          onOpenThread={onOpenThread}
        />
      );
    }
    return (
      <WorkflowBeatCard
        environmentId={environmentId}
        beat={beat}
        child={node.children.find((child) => child.run.runId === beat.childRun?.runId) ?? null}
        nowMs={nowMs}
        open={beat.thread !== null && beat.thread.threadId === openThreadId}
        onSelect={onSelect}
        onOpenThread={onOpenThread}
      />
    );
  };
  const resultLines = workflowResultLines(run.result);
  const scrollTo = (key: string) =>
    article.current
      ?.querySelector(`[data-step="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ block: "center" });

  return (
    <article
      ref={article}
      aria-label={run.title}
      className="mx-auto flex w-full max-w-3xl min-w-0 flex-col px-5 pt-5 pb-10"
    >
      <header className="space-y-1">
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
            className="block cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => onSelect(parent.runId)}
          >
            Part of {parent.title}
          </button>
        )}
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-base font-semibold break-words">{run.title}</h2>
          <WorkflowStateWord node={node} />
        </div>
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <WorkflowChip name={run.workflow} />
          <span>{run.workflow}</span>
          <span aria-hidden>·</span>
          <span>
            started <RelativeLabel value={run.startedAt} />
          </span>
          <span aria-hidden>·</span>
          <span>{ended ? `took ${formatDuration(ranMs)}` : `${formatDuration(ranMs)} so far`}</span>
          {run.retired ? (
            <>
              <span aria-hidden>·</span>
              <span>its version is no longer registered</span>
            </>
          ) : null}
          {ended ? null : (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                disabled={busy || !canCancel}
                className="cursor-pointer underline underline-offset-2 hover:text-destructive disabled:cursor-default disabled:opacity-60"
                onClick={() => void cancelRun()}
              >
                Cancel run
              </button>
            </>
          )}
        </p>
      </header>

      {path.length > 1 ? <WorkflowPath nodes={path} onPick={scrollTo} /> : null}

      <section aria-label="What happened" className="mt-4">
        {detail.error ? (
          <p className="text-xs text-destructive">{detail.error}</p>
        ) : feed === null ? (
          <p className="text-xs text-muted-foreground" role="status">
            Loading steps…
          </p>
        ) : (
          <ol className="min-w-0 space-y-2">
            {feed.map((row) =>
              row.kind === "quick" ? (
                <WorkflowQuickStepsRow key={`quick:${row.steps[0]?.name}`} row={row} />
              ) : row.kind === "together" ? (
                <li key={`together:${row.beats[0]?.name}`} className="space-y-1">
                  <p className="px-1 text-xs text-muted-foreground">At the same time</p>
                  <ul className="grid grid-cols-1 gap-2 @xl/feed:grid-cols-2">
                    {row.beats.map((beat) => (
                      <li key={beat.name} data-step={beat.name} className="min-w-0">
                        {beatCard(beat)}
                      </li>
                    ))}
                  </ul>
                </li>
              ) : (
                <li key={row.name} data-step={row.name} className="min-w-0">
                  {beatCard(row)}
                </li>
              ),
            )}
            {loose.map((question) => (
              <li key={`question:${question.name}`}>
                <WorkflowQuestionCard
                  environmentId={environmentId}
                  question={question}
                  onOpenThread={onOpenThread}
                />
              </li>
            ))}
            {run.status === "paused" && !failedAtStep ? (
              <li>{pause(null, run.pauses, run.detail)}</li>
            ) : null}
            {feed.length === 0 && loose.length === 0 && run.status !== "paused" && !ended ? (
              <li className="text-xs text-muted-foreground">Nothing yet.</li>
            ) : null}
            {ended ? (
              <li>
                <FeedCard tone={run.status === "completed" ? "done" : "plain"}>
                  <CardHead
                    mark={
                      run.status === "completed" ? (
                        <CheckIcon className="size-3.5 text-success-foreground" />
                      ) : null
                    }
                    name={
                      run.status === "completed"
                        ? "Finished"
                        : run.status === "stopped"
                          ? "Stopped"
                          : "Cancelled"
                    }
                    sub={<RelativeLabel value={run.endedAt ?? run.updatedAt} />}
                  />
                  {run.status !== "completed" && run.detail ? (
                    <p className="mt-1.5 text-sm break-words whitespace-pre-wrap">{run.detail}</p>
                  ) : null}
                  <ResultLines lines={resultLines} />
                </FeedCard>
              </li>
            ) : null}
          </ol>
        )}
      </section>
    </article>
  );
}

const PATH_CLASS: Record<WorkflowPathNode["status"], string> = {
  done: "border-border text-foreground",
  current: "border-primary font-semibold text-primary",
  failed: "border-destructive/50 text-destructive",
};

/** Where the run has been and where it is now. It never says what comes next: a run can branch. */
function WorkflowPath({
  nodes,
  onPick,
}: {
  readonly nodes: ReadonlyArray<WorkflowPathNode>;
  readonly onPick: (key: string) => void;
}) {
  return (
    <nav aria-label="Steps so far" className="mt-3 flex flex-wrap items-center gap-y-1.5">
      {nodes.map((node, index) => (
        <span key={node.key} className="flex items-center">
          {index === 0 ? null : <span aria-hidden className="h-px w-3 bg-border" />}
          <button
            type="button"
            className={cn(
              "flex cursor-pointer items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs whitespace-nowrap hover:bg-accent",
              PATH_CLASS[node.status],
            )}
            onClick={() => onPick(node.key)}
          >
            {node.status === "done" ? (
              <CheckIcon aria-hidden className="size-3 text-success-foreground" />
            ) : null}
            {node.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

const CARD_TONE = {
  plain: "border-border bg-card",
  quiet: "border-dashed border-border bg-transparent",
  ask: "border-primary/40 bg-primary/4",
  failed: "border-destructive/40 bg-destructive/4",
  done: "border-success/30 bg-success/4",
} as const;

function FeedCard({
  tone = "plain",
  selected = false,
  label,
  reveal = false,
  children,
}: {
  readonly tone?: keyof typeof CARD_TONE;
  readonly selected?: boolean;
  readonly label?: string;
  /** Scroll it into view when it first shows. */
  readonly reveal?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section
      ref={reveal ? revealOnMount : undefined}
      aria-label={label}
      className={cn(
        "h-full min-w-0 rounded-xl border px-3 py-2.5",
        CARD_TONE[tone],
        selected ? "ring-2 ring-primary/60" : null,
      )}
    >
      {children}
    </section>
  );
}

function CardHead({
  mark,
  name,
  sub,
  action,
}: {
  readonly mark: ReactNode;
  readonly name: ReactNode;
  readonly sub?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-2">
      {mark}
      <span className="min-w-0 truncate text-sm font-semibold">{name}</span>
      <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground">{sub}</span>
      {action}
    </div>
  );
}

function ResultLines({
  lines,
}: {
  readonly lines: ReadonlyArray<{ readonly label: string | null; readonly value: string }>;
}) {
  if (lines.length === 0) return null;
  return (
    <div className="mt-1.5 space-y-0.5 text-sm">
      {lines.map((line) => (
        <p key={line.label ?? line.value} className="break-words whitespace-pre-wrap">
          {line.label === null ? null : (
            <span className="text-muted-foreground">{line.label}: </span>
          )}
          {line.value}
        </p>
      ))}
    </div>
  );
}

/** Bookkeeping between the parts of a run that matter: one thin line, opened on request. */
function Hairline({
  children,
  detail,
}: {
  readonly children: ReactNode;
  readonly detail?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const line = "h-px bg-border";
  return (
    <div className="px-1 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn(line, "w-3")} />
        {detail === undefined ? (
          <span className="min-w-0 truncate">{children}</span>
        ) : (
          <button
            type="button"
            aria-expanded={open}
            className="flex min-w-0 cursor-pointer items-center gap-1 hover:text-foreground"
            onClick={() => setOpen(!open)}
          >
            <span className="min-w-0 truncate">{children}</span>
            <ChevronRightIcon className={cn("size-3 shrink-0", open ? "rotate-90" : null)} />
          </button>
        )}
        <span aria-hidden className={cn(line, "min-w-3 flex-1")} />
      </div>
      {open ? <div className="mt-1 ms-5">{detail}</div> : null}
    </div>
  );
}

function WorkflowQuickStepsRow({ row }: { readonly row: WorkflowQuickSteps }) {
  const names = row.steps.map((step) => step.name);
  const told =
    names.length <= 2
      ? names.join(", ")
      : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return (
    <li>
      <Hairline
        detail={
          <ul className="space-y-0.5">
            {row.steps.map((step) => {
              const line = workflowResultLines(step.result)
                .map((entry) =>
                  entry.label === null ? entry.value : `${entry.label}: ${entry.value}`,
                )
                .join(" · ");
              return (
                <li key={step.name} className="break-words">
                  <span className="text-foreground">{step.name}</span>
                  {line === "" ? null : ` ${line}`}
                </li>
              );
            })}
          </ul>
        }
      >
        {told}
      </Hairline>
    </li>
  );
}

function WorkflowBeatCard({
  environmentId,
  beat,
  child,
  nowMs,
  open,
  onSelect,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly beat: WorkflowBeat;
  readonly child: WorkflowRunNode | null;
  readonly nowMs: number;
  readonly open: boolean;
  readonly onSelect: (runId: string | null) => void;
  readonly onOpenThread: (thread: WorkflowThreadTarget) => void;
}) {
  const under = beat.status === "running";
  const length = formatDuration(beat.endMs - beat.startMs);
  const tries = beat.attempts > 1 ? ` · ${ordinal(beat.attempts)} try` : "";
  switch (beat.kind) {
    case "agent":
      return (
        <WorkflowAgentCard
          environmentId={environmentId}
          beat={beat}
          open={open}
          onOpenThread={onOpenThread}
        />
      );
    case "ask": {
      const answer = workflowAnswer(beat.result);
      if (answer === null)
        return (
          <Hairline>
            nobody answered {beat.name} in {length}
          </Hairline>
        );
      return (
        <FeedCard label={beat.name}>
          <CardHead
            mark={<CheckIcon className="size-3.5 text-success-foreground" />}
            name="Answered"
            sub={`${beat.name} · after ${length}`}
          />
          <p className="mt-1 text-sm">
            You said <span className="font-semibold">{answer.choice}</span>
            {answer.reason === null ? "." : `: ${answer.reason}`}
          </p>
        </FeedCard>
      );
    }
    case "sleep": {
      if (!under)
        return (
          <Hairline>
            slept {length} at {beat.name}
          </Hairline>
        );
      const wakes = beat.detail === null ? Number.NaN : Date.parse(beat.detail);
      return (
        <FeedCard tone="quiet" label={beat.name}>
          <CardHead
            mark={<MoonIcon className="size-3.5 text-muted-foreground" />}
            name="Sleeping"
            sub={
              Number.isFinite(wakes) && wakes > nowMs
                ? `${beat.name} · wakes in ${formatDuration(wakes - nowMs)}`
                : `${beat.name} · about to wake`
            }
          />
        </FeedCard>
      );
    }
    case "wait":
      if (!under)
        return (
          <Hairline>
            waited {length} for {beat.name}
          </Hairline>
        );
      return (
        <FeedCard tone="quiet" label={beat.name}>
          <CardHead
            mark={<HourglassIcon className="size-3.5 text-muted-foreground" />}
            name="Waiting"
            sub={`for ${beat.name} · ${length} so far`}
          />
        </FeedCard>
      );
    case "run": {
      const title = beat.childRun?.title ?? beat.name;
      return (
        <FeedCard label={title}>
          <CardHead
            mark={<WorkflowChip name={beat.childRun?.workflow ?? beat.name} />}
            name={title}
            sub={
              child === null
                ? `${beat.childRun?.workflow ?? ""} · ${length}`
                : `${child.run.workflow} · ${workflowRunNow(child)}`
            }
            action={
              <>
                {child === null ? null : <WorkflowStateWord node={child} />}
                <Button
                  size="compact"
                  variant="outline"
                  onClick={() => onSelect(beat.childRun?.runId ?? null)}
                >
                  Open run
                </Button>
              </>
            }
          />
        </FeedCard>
      );
    }
    case "step": {
      if (under) {
        return (
          <FeedCard tone="quiet" label={beat.name}>
            <CardHead
              mark={<span aria-hidden className="size-1.5 rounded-full bg-info" />}
              name={beat.name}
              sub={`running for ${length}${tries}`}
            />
          </FeedCard>
        );
      }
      const lines = workflowResultLines(beat.result);
      return (
        <Hairline detail={lines.length === 0 ? undefined : <ResultLines lines={lines} />}>
          {beat.status === "failed" ? `${beat.name} failed` : beat.name} · {length}
          {tries}
        </Hairline>
      );
    }
  }
}

function WorkflowAgentCard({
  environmentId,
  beat,
  open,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly beat: WorkflowBeat;
  readonly open: boolean;
  readonly onOpenThread: (thread: WorkflowThreadTarget) => void;
}) {
  const [all, setAll] = useState(false);
  const elsewhere = beat.thread !== null && beat.thread.environmentId !== null;
  const threadEnvironmentId =
    beat.thread?.environmentId == null
      ? environmentId
      : EnvironmentId.make(beat.thread.environmentId);
  // This client can only show a thread on an environment it is itself connected to.
  const threadEnvironment = useEnvironment(threadEnvironmentId);
  const shell = useQuietThreadShell(
    beat.thread === null
      ? null
      : scopeThreadRef(threadEnvironmentId, ThreadId.make(beat.thread.threadId)),
  );
  const provider = useEnvironmentProviders()
    .get(threadEnvironmentId)
    ?.find((candidate) => candidate.instanceId === shell?.modelSelection.instanceId);
  const under = beat.status === "running";
  const length = formatDuration(beat.endMs - beat.startMs);
  const summary = workflowAgentSummary(beat);
  const start = summary.said === null ? null : workflowSaidStart(summary.said, SAID_SHOWN);
  const sub = [
    shell === null ? null : formatModelSlugName(shell.modelSelection.model),
    under ? `working for ${length}` : length,
    beat.attempts > 1 ? `${ordinal(beat.attempts)} try` : null,
    elsewhere ? `on ${threadEnvironment?.label ?? threadEnvironmentId}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <FeedCard label={beat.name} selected={open}>
      <CardHead
        mark={
          provider === undefined ? (
            <BotIcon
              aria-hidden
              className={cn("size-4", under ? "text-info-foreground" : "text-muted-foreground")}
            />
          ) : (
            <ProviderInstanceIcon
              driverKind={provider.driver}
              displayName={provider.displayName ?? provider.instanceId}
              accentColor={provider.accentColor}
              size="compact"
            />
          )
        }
        name={beat.name}
        sub={sub}
        action={
          beat.thread === null ? null : threadEnvironment === null ? (
            <span className="text-xs text-muted-foreground">Thread on {threadEnvironmentId}</span>
          ) : (
            <Button
              size="compact"
              variant={open ? "secondary" : "outline"}
              aria-pressed={open}
              onClick={() => beat.thread !== null && onOpenThread(beat.thread)}
            >
              {under ? "Watch live" : "Transcript"}
            </Button>
          )
        }
      />
      {beat.status === "failed" && beat.detail ? (
        <p className="mt-1.5 flex gap-1.5 text-sm text-destructive">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words whitespace-pre-wrap">{beat.detail}</span>
        </p>
      ) : null}
      {summary.said === null ? null : (
        <div className="mt-1.5">
          <ChatMarkdown
            text={start !== null && !all ? start : summary.said}
            cwd={undefined}
            className="text-sm"
          />
          {start !== null ? (
            <button
              type="button"
              aria-expanded={all}
              className="mt-1 cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => setAll(!all)}
            >
              {all ? "Show less" : "Show all of it"}
            </button>
          ) : null}
        </div>
      )}
      {summary.facts.length === 0 ? null : (
        <dl className="mt-2 flex flex-wrap gap-1.5">
          {summary.facts.map((fact) => (
            <div key={fact.label} className="flex gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="font-medium">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </FeedCard>
  );
}

function WorkflowPauseCard({
  run,
  name,
  attempts,
  reason,
  nowMs,
  disabled,
  onResume,
}: {
  readonly run: WorkflowRun;
  /** The step it stopped at, when the steps say which. */
  readonly name: string | null;
  readonly attempts: number;
  readonly reason: string | null;
  readonly nowMs: number;
  readonly disabled: boolean;
  readonly onResume: () => void;
}) {
  const resumes = run.resumesAt === null ? Number.NaN : Date.parse(run.resumesAt);
  const next = run.retired
    ? "cannot go on until its workflow version is registered again"
    : !Number.isFinite(resumes)
      ? "waits for you to resume it"
      : resumes > nowMs
        ? `tries again by itself in ${formatDuration(resumes - nowMs)}`
        : "about to try again by itself";
  return (
    <FeedCard tone="failed" label="Why it paused" reveal>
      <CardHead
        mark={<CircleAlertIcon className="size-3.5 text-destructive" />}
        name={name === null ? "Paused" : `Paused at ${name}`}
        sub={
          <>
            {attempts > 0 ? `${ordinal(attempts)} try · ` : null}
            <RelativeLabel value={run.updatedAt} /> · {next}
          </>
        }
        action={
          <Button size="compact" disabled={disabled} onClick={onResume}>
            Resume now
          </Button>
        }
      />
      {reason ? <p className="mt-1.5 text-sm break-words whitespace-pre-wrap">{reason}</p> : null}
      <p className="mt-1.5 text-xs text-muted-foreground">
        Only the failed step runs again; what finished before it is kept.
      </p>
    </FeedCard>
  );
}

function WorkflowQuestionCard({
  environmentId,
  question,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly question: WorkflowQuestion;
  readonly onOpenThread: (thread: WorkflowThreadTarget) => void;
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
  const threadEnvironmentId =
    question.thread?.environmentId == null
      ? environmentId
      : EnvironmentId.make(question.thread.environmentId);
  const reachable = useEnvironment(threadEnvironmentId) !== null;
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
    <FeedCard tone="ask" label={view.title} reveal>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("font-medium", WORKFLOW_TONE_CLASS.input)}>Input</span>
        <span>
          asked <RelativeLabel value={question.askedAt} /> · the run waits for you
        </span>
      </p>
      <h3 className="mt-1 text-sm font-semibold break-words">{view.title}</h3>
      {view.body ? (
        <ChatMarkdown text={view.body} cwd={undefined} className="mt-1 text-sm" />
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
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
        {question.thread === null || !reachable ? null : (
          <button
            type="button"
            className="cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => question.thread !== null && onOpenThread(question.thread)}
          >
            Ask the agent first
          </button>
        )}
      </div>
      {reason === null ? null : (
        <div className="mt-2">
          <Input
            size="sm"
            autoFocus
            value={reason}
            disabled={busy || !canAnswer}
            aria-label={`Reason for ${view.title}`}
            placeholder="Why, in a sentence. It goes with whichever answer you pick."
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </div>
      )}
    </FeedCard>
  );
}
