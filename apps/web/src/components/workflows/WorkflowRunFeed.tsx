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
import { msg, T, useGT, useMessages, Var } from "gt-react";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckIcon,
  CircleHelpIcon,
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
import { type MessageResolver } from "../../i18n/messages";
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
  workflowFlowFocus,
  workflowResultLines,
  workflowRunNow,
  workflowRunState,
  workflowSaidStart,
  type WorkflowBeat,
  type WorkflowFeedRow,
  type WorkflowQuickSteps,
  type WorkflowRunNode,
  type WorkflowRunTone,
} from "@t3tools/client-runtime/workflows";

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
const WORKFLOW_TONE_CLASS: Record<WorkflowRunTone, string> = {
  input: "text-primary",
  failed: "text-destructive",
  working: "text-info-foreground",
  quiet: "text-muted-foreground",
  done: "text-success-foreground",
};

export function WorkflowStateWord({ node }: { readonly node: WorkflowRunNode }) {
  const m = useMessages();
  const state = workflowRunState(node, m);
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

const nthTry = (count: number, resolve: MessageResolver) =>
  resolve(
    msg("{count, plural, =1 {1st try} =2 {2nd try} =3 {3rd try} other {{count}th try}}", {
      count,
    }),
  );

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
  const gt = useGT();
  const nowMs = useNowMs();
  const panel = useRef<HTMLElement | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
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
    reportFailure(gt("Could not resume the run"), result);
  };
  const cancelRun = async () => {
    if (busy) return;
    const confirmed = await (requestConfirmDialog(
      gt("Cancel {title}? Its agents stop and the run cannot be resumed.", { title: run.title }),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await cancel(target);
    setBusy(false);
    reportFailure(gt("Could not cancel the run"), result);
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
  const pausedApart = run.status === "paused" && !failedAtStep;
  const keys = new Set([
    ...(feed ?? []).flatMap((row) => (row.kind === "quick" ? [`quick:${row.steps[0]?.name}`] : [])),
    ...beats.map((beat) => `step:${beat.name}`),
    ...loose.map((question) => `question:${question.name}`),
    ...(pausedApart ? ["pause"] : []),
    ...(ended ? ["end"] : []),
  ]);
  const focus =
    picked !== null && keys.has(picked)
      ? picked
      : feed === null
        ? null
        : workflowFlowFocus({
            rows: feed,
            status: run.status,
            ended,
            questions: node.questions.map((question) => question.name),
          });
  const pick = (key: string) => {
    setPicked(key);
    // Below the flow on a narrow page, so picking a step brings what it shows into view.
    panel.current?.scrollIntoView({ block: "nearest" });
  };
  const endWord =
    run.status === "completed"
      ? gt("Finished", { $context: "how a workflow run ended" })
      : run.status === "stopped"
        ? gt("Stopped", { $context: "how a workflow run ended" })
        : run.status === "skipped"
          ? gt("Skipped", { $context: "how a workflow run ended" })
          : gt("Cancelled", { $context: "how a workflow run ended" });
  const shownBeat = beats.find((beat) => `step:${beat.name}` === focus);
  const shownQuick = (feed ?? []).find(
    (row) => row.kind === "quick" && `quick:${row.steps[0]?.name}` === focus,
  );
  const shownQuestion = loose.find((question) => `question:${question.name}` === focus);

  return (
    <article
      aria-label={run.title}
      className="mx-auto flex w-full max-w-4xl min-w-0 flex-col px-5 pt-5 pb-10"
    >
      <header className="space-y-1">
        <Button
          size="sm"
          variant="ghost"
          className="md:hidden"
          onClick={() => onSelect(null)}
          aria-label={gt("Back to the list of runs")}
        >
          <ArrowLeftIcon />
          <T context="noun, the list of workflow runs">Runs</T>
        </Button>
        {parent === null ? null : (
          <button
            type="button"
            className="block cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => onSelect(parent.runId)}
          >
            <T>
              Part of <Var>{parent.title}</Var>
            </T>
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
            <T>
              started{" "}
              <Var>
                <RelativeLabel value={run.startedAt} />
              </Var>
            </T>
          </span>
          <span aria-hidden>·</span>
          <span>
            {ended
              ? gt("took {duration}", { duration: formatDuration(ranMs) })
              : gt("{duration} so far", { duration: formatDuration(ranMs) })}
          </span>
          {run.retired ? (
            <>
              <span aria-hidden>·</span>
              <span>
                <T>its version is no longer registered</T>
              </span>
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
                <T>Cancel run</T>
              </button>
            </>
          )}
        </p>
      </header>

      {detail.error ? (
        <p className="mt-4 text-xs text-destructive">{detail.error}</p>
      ) : feed === null ? (
        <p className="mt-4 text-xs text-muted-foreground" role="status">
          <T>Loading steps…</T>
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-4 @2xl/feed:flex-row @2xl/feed:items-start">
          <WorkflowFlow
            environmentId={environmentId}
            rows={feed}
            node={node}
            nowMs={nowMs}
            focus={focus}
            onPick={pick}
            loose={loose}
            paused={pausedApart}
            end={ended ? endWord : null}
          />
          <section
            ref={panel}
            aria-label={gt("What happened")}
            className="min-w-0 flex-1 @2xl/feed:sticky @2xl/feed:top-4"
          >
            {shownBeat !== undefined ? (
              <div data-step={shownBeat.name}>{beatCard(shownBeat)}</div>
            ) : shownQuick !== undefined && shownQuick.kind === "quick" ? (
              <WorkflowQuickStepsCard row={shownQuick} />
            ) : shownQuestion !== undefined ? (
              <WorkflowQuestionCard
                environmentId={environmentId}
                question={shownQuestion}
                onOpenThread={onOpenThread}
              />
            ) : focus === "pause" ? (
              pause(null, run.pauses, run.detail)
            ) : focus === "end" ? (
              <FeedCard tone={run.status === "completed" ? "done" : "plain"}>
                <CardHead
                  mark={
                    run.status === "completed" ? (
                      <CheckIcon className="size-3.5 text-success-foreground" />
                    ) : null
                  }
                  name={endWord}
                  sub={<RelativeLabel value={run.endedAt ?? run.updatedAt} />}
                />
                {run.status !== "completed" && run.detail ? (
                  <p className="mt-1.5 text-sm break-words whitespace-pre-wrap">{run.detail}</p>
                ) : null}
                <ResultLines lines={resultLines} />
              </FeedCard>
            ) : (
              <p className="text-xs text-muted-foreground">
                <T>Nothing yet.</T>
              </p>
            )}
          </section>
        </div>
      )}
    </article>
  );
}

const FLOW_TONE = {
  plain: "border-border bg-card",
  ask: "border-primary/40 bg-primary/4",
  failed: "border-destructive/40 bg-destructive/4",
} as const;

const firstSentence = (text: string) => {
  const line = text.trim().split("\n", 1)[0] ?? "";
  const end = line.search(/[.!?](\s|$)/);
  return end === -1 ? line : line.slice(0, end + 1);
};

/** The straight piece of wire between two parts of the flow. */
function Wire({ live = false }: { readonly live?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mx-auto block h-4 w-0 border-l-2",
        live ? "h-6 border-dashed border-primary" : "border-border",
      )}
    />
  );
}

/** One wire becoming several, or several becoming one, for steps that ran at the same time. */
function Branch({ count, join = false }: { readonly count: number; readonly join?: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      className="block h-5 w-full text-border"
    >
      {Array.from({ length: count }, (_, index) => {
        const x = ((index + 0.5) / count) * 100;
        return (
          <path
            key={x}
            d={join ? `M${x} 0 C${x} 12, 50 8, 50 20` : `M50 0 C50 12, ${x} 8, ${x} 20`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

/**
 * The run as it went: one node per step that took time or involved someone, side by side where
 * they ran at once. It never draws what comes next: a run can branch.
 */
function WorkflowFlow({
  environmentId,
  rows,
  node,
  nowMs,
  focus,
  onPick,
  loose,
  paused,
  end,
}: {
  readonly environmentId: EnvironmentId;
  readonly rows: ReadonlyArray<WorkflowFeedRow>;
  readonly node: WorkflowRunNode;
  readonly nowMs: number;
  readonly focus: string | null;
  readonly onPick: (key: string) => void;
  /** Questions whose step is not in the list yet. */
  readonly loose: ReadonlyArray<WorkflowQuestion>;
  /** The run is paused, and not at a step that failed. */
  readonly paused: boolean;
  /** How the run ended, once it has. */
  readonly end: string | null;
}) {
  const gt = useGT();
  const beats = rows.flatMap((row) =>
    row.kind === "quick" ? [] : row.kind === "together" ? row.beats : [row],
  );
  const longestMs = Math.max(1, ...beats.map((beat) => beat.endMs - beat.startMs));
  const beatNode = (beat: WorkflowBeat) => (
    <WorkflowFlowNode
      environmentId={environmentId}
      beat={beat}
      child={node.children.find((child) => child.run.runId === beat.childRun?.runId) ?? null}
      asks={node.questions.some((question) => question.name === beat.name)}
      nowMs={nowMs}
      share={(beat.endMs - beat.startMs) / longestMs}
      selected={focus === `step:${beat.name}`}
      onPick={() => onPick(`step:${beat.name}`)}
    />
  );
  const plainNode = (key: string, tone: keyof typeof FLOW_TONE, name: string, sub: string) => (
    <div className="mx-auto w-56 max-w-full">
      <FlowButton tone={tone} selected={focus === key} onPick={() => onPick(key)}>
        <span className="block truncate text-xs font-semibold">{name}</span>
        <span className="block truncate text-2xs text-muted-foreground">{sub}</span>
      </FlowButton>
    </div>
  );
  const waits = node.questions.length > 0;
  return (
    <nav aria-label={gt("Steps so far")} className="w-full shrink-0 @2xl/feed:w-72">
      <span aria-hidden className="mx-auto block size-2 rounded-full bg-muted-foreground" />
      {rows.map((row) => {
        if (row.kind === "quick") {
          const key = `quick:${row.steps[0]?.name}`;
          const names = row.steps.map((step) => step.name);
          return (
            <div key={key} className="relative">
              <Wire />
              <Wire />
              <button
                type="button"
                aria-current={focus === key}
                className={cn(
                  "absolute top-1/2 left-1/2 ms-3 max-w-[45%] -translate-y-1/2 cursor-pointer truncate text-2xs text-muted-foreground hover:text-foreground",
                  focus === key ? "font-semibold text-foreground" : null,
                )}
                onClick={() => onPick(key)}
              >
                {names.length <= 2
                  ? names.join(", ")
                  : gt("{names} and {count} more", {
                      names: names.slice(0, 2).join(", "),
                      count: names.length - 2,
                    })}
              </button>
            </div>
          );
        }
        if (row.kind === "together") {
          return (
            <div key={`together:${row.beats[0]?.name}`}>
              <Wire />
              <Branch count={row.beats.length} />
              <p className="-mt-3 mb-0.5 text-center text-3xs text-muted-foreground">
                <span className="bg-background px-1">
                  <T>at the same time</T>
                </span>
              </p>
              <div
                className="grid gap-1.5"
                style={{ gridTemplateColumns: `repeat(${row.beats.length}, minmax(0, 1fr))` }}
              >
                {row.beats.map((beat) => (
                  <div key={beat.name} className="min-w-0">
                    {beatNode(beat)}
                  </div>
                ))}
              </div>
              <Branch count={row.beats.length} join />
            </div>
          );
        }
        return (
          <div key={row.name}>
            <Wire />
            <div className="mx-auto w-56 max-w-full">{beatNode(row)}</div>
          </div>
        );
      })}
      {loose.map((question) => (
        <div key={`question:${question.name}`}>
          <Wire />
          {plainNode(
            `question:${question.name}`,
            "ask",
            question.name,
            gt("Asks you", { $context: "a workflow step waits on a person's answer" }),
          )}
        </div>
      ))}
      {paused ? (
        <>
          <Wire />
          {plainNode(
            "pause",
            "failed",
            gt("Paused", { $context: "a workflow run is paused" }),
            node.run.detail ?? "",
          )}
        </>
      ) : null}
      {end === null ? (
        <>
          <Wire live />
          <p className="text-center text-2xs font-medium text-primary">
            {waits
              ? gt("goes on when you answer")
              : node.run.status === "paused"
                ? gt("goes on when it is resumed")
                : null}
          </p>
        </>
      ) : (
        <>
          <Wire />
          {plainNode("end", "plain", end, "")}
        </>
      )}
    </nav>
  );
}

function FlowButton({
  tone,
  selected,
  onPick,
  children,
}: {
  readonly tone: keyof typeof FLOW_TONE;
  readonly selected: boolean;
  readonly onPick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={selected}
      className={cn(
        "block w-full min-w-0 cursor-pointer rounded-lg border px-2.5 py-1.5 text-left hover:bg-accent",
        FLOW_TONE[tone],
        selected ? "border-primary ring-2 ring-primary/25" : null,
      )}
      onClick={onPick}
    >
      {children}
    </button>
  );
}

function WorkflowFlowNode({
  environmentId,
  beat,
  child,
  asks,
  nowMs,
  share,
  selected,
  onPick,
}: {
  readonly environmentId: EnvironmentId;
  readonly beat: WorkflowBeat;
  readonly child: WorkflowRunNode | null;
  /** A person's answer is what it waits for. */
  readonly asks: boolean;
  readonly nowMs: number;
  /** How long it took, as a share of the longest step. */
  readonly share: number;
  readonly selected: boolean;
  readonly onPick: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const threadEnvironmentId =
    beat.thread?.environmentId == null
      ? environmentId
      : EnvironmentId.make(beat.thread.environmentId);
  const shell = useQuietThreadShell(
    beat.thread === null
      ? null
      : scopeThreadRef(threadEnvironmentId, ThreadId.make(beat.thread.threadId)),
  );
  const provider = useEnvironmentProviders()
    .get(threadEnvironmentId)
    ?.find((candidate) => candidate.instanceId === shell?.modelSelection.instanceId);
  const under = beat.status === "running";
  const failed = beat.status === "failed";
  const length = formatDuration(beat.endMs - beat.startMs);
  const said = workflowAgentSummary(beat).said;
  const answer = beat.kind === "ask" ? workflowAnswer(beat.result) : null;
  const wakes = beat.detail === null ? Number.NaN : Date.parse(beat.detail);
  const sub = (() => {
    if (failed) return gt("failed after {duration}", { duration: length });
    switch (beat.kind) {
      case "agent":
        return [
          shell === null ? null : formatModelSlugName(shell.modelSelection.model),
          under
            ? gt("working for {duration}", { duration: length })
            : said === null
              ? length
              : firstSentence(said),
        ]
          .filter((part) => part !== null)
          .join(" · ");
      case "ask":
        return under
          ? asks
            ? gt("Asks you · waiting {duration}", { duration: length })
            : gt("waiting {duration}", { duration: length })
          : answer === null
            ? gt("nobody answered")
            : gt("You said {choice}", { choice: answer.choice });
      case "sleep":
        return !under
          ? gt("slept {duration}", { duration: length })
          : Number.isFinite(wakes) && wakes > nowMs
            ? gt("wakes in {duration}", { duration: formatDuration(wakes - nowMs) })
            : gt("about to wake");
      case "wait":
        return under
          ? gt("waiting {duration}", { duration: length })
          : gt("waited {duration}", { duration: length });
      case "run":
        return child === null ? length : workflowRunNow(child, m);
      case "step":
        return under ? gt("running for {duration}", { duration: length }) : length;
    }
  })();
  const mark =
    beat.kind === "agent" ? (
      provider === undefined ? (
        <BotIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={provider.displayName ?? provider.instanceId}
          accentColor={provider.accentColor}
          size="compact"
        />
      )
    ) : beat.kind === "ask" ? (
      <CircleHelpIcon aria-hidden className="size-3.5 shrink-0" />
    ) : beat.kind === "sleep" ? (
      <MoonIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    ) : beat.kind === "wait" ? (
      <HourglassIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    ) : beat.kind === "run" ? (
      <WorkflowChip name={beat.childRun?.workflow ?? beat.name} />
    ) : null;
  return (
    <FlowButton
      tone={failed ? "failed" : under && asks ? "ask" : "plain"}
      selected={selected}
      onPick={onPick}
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-xs font-semibold",
          under && asks ? "text-primary" : null,
        )}
      >
        {mark}
        <span className="min-w-0 truncate">{beat.childRun?.title ?? beat.name}</span>
        {under ? (
          asks ? null : (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
          )
        ) : failed ? (
          <CircleAlertIcon aria-hidden className="size-3 shrink-0 text-destructive" />
        ) : (
          <CheckIcon aria-hidden className="size-3 shrink-0 text-success-foreground" />
        )}
      </span>
      <span className="block truncate text-2xs text-muted-foreground">{sub}</span>
      {under ? null : (
        <span aria-hidden className="mt-1.5 block h-0.5 rounded-full bg-border">
          <span
            className="block h-full rounded-full bg-muted-foreground/55"
            style={{ width: `${Math.max(4, Math.round(share * 100))}%` }}
          />
        </span>
      )}
    </FlowButton>
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

/** A step with nothing to show but that it happened, and what it left behind. */
function Note({
  label,
  children,
  detail,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly detail?: ReactNode;
}) {
  return (
    <FeedCard label={label}>
      <p className="text-sm text-muted-foreground">{children}</p>
      {detail}
    </FeedCard>
  );
}

function WorkflowQuickStepsCard({ row }: { readonly row: WorkflowQuickSteps }) {
  const gt = useGT();
  return (
    <FeedCard label={gt("Quick steps")}>
      <ul className="space-y-1.5 text-sm">
        {row.steps.map((step) => (
          <li key={step.name} className="break-words">
            <span className="font-semibold">{step.name}</span>
            <ResultLines lines={workflowResultLines(step.result)} />
          </li>
        ))}
      </ul>
    </FeedCard>
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
  const gt = useGT();
  const m = useMessages();
  const under = beat.status === "running";
  const length = formatDuration(beat.endMs - beat.startMs);
  const tries = beat.attempts > 1 ? ` · ${nthTry(beat.attempts, m)}` : "";
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
          <Note label={beat.name}>
            {gt("nobody answered {step} in {duration}", { step: beat.name, duration: length })}
          </Note>
        );
      return (
        <FeedCard label={beat.name}>
          <CardHead
            mark={<CheckIcon className="size-3.5 text-success-foreground" />}
            name={gt("Answered", { $context: "a person answered the workflow's question" })}
            sub={gt("{step} · after {duration}", { step: beat.name, duration: length })}
          />
          <p className="mt-1 text-sm">
            {answer.reason === null ? (
              <T>
                You said{" "}
                <span className="font-semibold">
                  <Var>{answer.choice}</Var>
                </span>
                .
              </T>
            ) : (
              <T>
                You said{" "}
                <span className="font-semibold">
                  <Var>{answer.choice}</Var>
                </span>
                : <Var>{answer.reason}</Var>
              </T>
            )}
          </p>
        </FeedCard>
      );
    }
    case "sleep": {
      if (!under)
        return (
          <Note label={beat.name}>
            {gt("slept {duration} at {step}", { duration: length, step: beat.name })}
          </Note>
        );
      const wakes = beat.detail === null ? Number.NaN : Date.parse(beat.detail);
      return (
        <FeedCard tone="quiet" label={beat.name}>
          <CardHead
            mark={<MoonIcon className="size-3.5 text-muted-foreground" />}
            name={gt("Sleeping", { $context: "a workflow step is sleeping" })}
            sub={
              Number.isFinite(wakes) && wakes > nowMs
                ? gt("{step} · wakes in {duration}", {
                    step: beat.name,
                    duration: formatDuration(wakes - nowMs),
                  })
                : gt("{step} · about to wake", { step: beat.name })
            }
          />
        </FeedCard>
      );
    }
    case "wait":
      if (!under)
        return (
          <Note label={beat.name}>
            {gt("waited {duration} for {step}", { duration: length, step: beat.name })}
          </Note>
        );
      return (
        <FeedCard tone="quiet" label={beat.name}>
          <CardHead
            mark={<HourglassIcon className="size-3.5 text-muted-foreground" />}
            name={gt("Waiting", { $context: "a workflow step is waiting" })}
            sub={gt("for {step} · {duration} so far", { step: beat.name, duration: length })}
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
                : `${child.run.workflow} · ${workflowRunNow(child, m)}`
            }
            action={
              <>
                {child === null ? null : <WorkflowStateWord node={child} />}
                <Button
                  size="compact"
                  variant="outline"
                  onClick={() => onSelect(beat.childRun?.runId ?? null)}
                >
                  <T>Open run</T>
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
              sub={`${gt("running for {duration}", { duration: length })}${tries}`}
            />
          </FeedCard>
        );
      }
      const lines = workflowResultLines(beat.result);
      return (
        <Note label={beat.name} detail={<ResultLines lines={lines} />}>
          {beat.status === "failed" ? gt("{step} failed", { step: beat.name }) : beat.name} ·{" "}
          {length}
          {tries}
        </Note>
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
  const gt = useGT();
  const m = useMessages();
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
    under ? gt("working for {duration}", { duration: length }) : length,
    beat.attempts > 1 ? nthTry(beat.attempts, m) : null,
    elsewhere
      ? gt("on {environment}", { environment: threadEnvironment?.label ?? threadEnvironmentId })
      : null,
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
            <span className="text-xs text-muted-foreground">
              <T>
                Thread on <Var>{threadEnvironmentId}</Var>
              </T>
            </span>
          ) : (
            <Button
              size="compact"
              variant={open ? "secondary" : "outline"}
              aria-pressed={open}
              onClick={() => beat.thread !== null && onOpenThread(beat.thread)}
            >
              {under
                ? gt("Watch live")
                : gt("Transcript", { $context: "button that opens an agent's thread" })}
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
              {all ? gt("Show less") : gt("Show all of it")}
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
  const gt = useGT();
  const m = useMessages();
  const resumes = run.resumesAt === null ? Number.NaN : Date.parse(run.resumesAt);
  const next = run.retired
    ? gt("cannot go on until its workflow version is registered again")
    : !Number.isFinite(resumes)
      ? gt("waits for you to resume it")
      : resumes > nowMs
        ? gt("tries again by itself in {duration}", { duration: formatDuration(resumes - nowMs) })
        : gt("about to try again by itself");
  return (
    <FeedCard tone="failed" label={gt("Why it paused")} reveal>
      <CardHead
        mark={<CircleAlertIcon className="size-3.5 text-destructive" />}
        name={
          name === null
            ? gt("Paused", { $context: "a workflow run is paused" })
            : gt("Paused at {step}", { step: name })
        }
        sub={
          <>
            {attempts > 0 ? `${nthTry(attempts, m)} · ` : null}
            <RelativeLabel value={run.updatedAt} /> · {next}
          </>
        }
        action={
          <Button size="compact" disabled={disabled} onClick={onResume}>
            <T>Resume now</T>
          </Button>
        }
      />
      {reason ? <p className="mt-1.5 text-sm break-words whitespace-pre-wrap">{reason}</p> : null}
      <p className="mt-1.5 text-xs text-muted-foreground">
        <T>Only the failed step runs again; what finished before it is kept.</T>
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
  const gt = useGT();
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
    reportFailure(gt("Could not answer the question"), result);
  };
  return (
    <FeedCard tone="ask" label={view.title} reveal>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("font-medium", WORKFLOW_TONE_CLASS.input)}>
          <T context="the workflow run waits on a person">Input</T>
        </span>
        <span>
          <T>
            asked{" "}
            <Var>
              <RelativeLabel value={question.askedAt} />
            </Var>{" "}
            · the run waits for you
          </T>
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
            <T>Add a reason</T>
          </Button>
        ) : null}
        {question.thread === null || !reachable ? null : (
          <button
            type="button"
            className="cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => question.thread !== null && onOpenThread(question.thread)}
          >
            <T>Ask the agent first</T>
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
            aria-label={gt("Reason for {title}", { title: view.title })}
            placeholder={gt("Why, in a sentence. It goes with whichever answer you pick.")}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </div>
      )}
    </FeedCard>
  );
}
