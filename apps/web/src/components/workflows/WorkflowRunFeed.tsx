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
  type WorkflowRunReference,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  HourglassIcon,
  MoonIcon,
  SquareIcon,
} from "lucide-react";
import { secondTick } from "@t3tools/client-runtime/clock";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";

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
  workflowPausedBeat,
  workflowResultLines,
  workflowRunNow,
  workflowRunState,
  workflowSaidStart,
  workflowStepReferences,
  type WorkflowBeat,
  type WorkflowFeedRow,
  type WorkflowQuickSteps,
  type WorkflowRunNode,
  type WorkflowRunTone,
} from "@t3tools/client-runtime/workflows";
import type { WorkflowPaneTab } from "./workflowPane.logic";
import { WorkflowReferenceChip } from "./WorkflowReferences";

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

// A time still counting is told to the second: its tenths would only flicker.
const wholeSeconds = (ms: number) => Math.max(1000, Math.round(ms / 1000) * 1000);
const elapsedOf = (beat: WorkflowBeat) =>
  beat.status === "running" ? wholeSeconds(beat.endMs - beat.startMs) : beat.endMs - beat.startMs;

const never = () => () => {};
const noTick = () => 0;

/** The clock a run is told by: to the second while it is under way, to the minute after. */
function useRunNowMs(live: boolean): number {
  const minute = useNowMs();
  const second = useSyncExternalStore(
    live ? secondTick.subscribe : never,
    live ? secondTick.getSnapshot : noTick,
    live ? secondTick.getSnapshot : noTick,
  );
  return live ? second : minute;
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
  input: "text-warning-foreground",
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
  shownTab,
  onSelect,
  onOpenThread,
  onOpenReference,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: WorkflowRunNode;
  readonly parent: WorkflowRun | null;
  /** What shows beside the run, so the card or chip that opened it can say so. */
  readonly shownTab: WorkflowPaneTab | null;
  readonly onSelect: (runId: string | null) => void;
  readonly onOpenThread: (thread: WorkflowThreadTarget) => void;
  readonly onOpenReference: (reference: WorkflowRunReference) => void;
}) {
  const { run } = node;
  const gt = useGT();
  const clockMs = useRunNowMs(node.run.endedAt === null);
  // An ended run's last step can still read as running for a moment; it ran until the run ended.
  const nowMs = node.run.endedAt === null ? clockMs : Date.parse(node.run.endedAt);
  const panel = useRef<HTMLElement | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  // Steps already there when the run opens are simply shown; only later ones arrive with motion.
  const [openedAtMs] = useState(() => Date.now());
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
    // Busy while the dialog is up, so a second click does not open a second one.
    setBusy(true);
    const confirmed = await (requestConfirmDialog(
      gt("Cancel {title}? Its agents stop and the run cannot be resumed.", { title: run.title }),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return setBusy(false);
    const result = await cancel(target);
    setBusy(false);
    reportFailure(gt("Could not cancel the run"), result);
  };
  const ended = run.endedAt !== null;
  const ranMs = ended
    ? Date.parse(run.endedAt) - Date.parse(run.startedAt)
    : wholeSeconds(nowMs - Date.parse(run.startedAt));
  const steps = detail.data?.steps;
  const references = detail.data?.references ?? [];
  const openThreadId = shownTab !== null && "thread" in shownTab ? shownTab.thread : null;
  const chip = (reference: WorkflowRunReference, small = false) => (
    <WorkflowReferenceChip
      key={`${reference.kind}:${reference.key}`}
      reference={reference}
      small={small}
      open={
        shownTab !== null &&
        "kind" in shownTab &&
        shownTab.kind === reference.kind &&
        shownTab.key === reference.key
      }
      onOpen={() => onOpenReference(reference)}
    />
  );
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
  const pausedAt = feed === null ? null : workflowPausedBeat(feed, run.status);
  const pause = (name: string | null, attempts: number, reason: string | null) => (
    <WorkflowPauseCard
      run={run}
      name={name}
      attempts={attempts}
      reason={reason}
      nowMs={nowMs}
      disabled={busy || !canResume || run.retired}
      onResume={() => void resumeRun()}
      kept={(steps ?? []).some((step) => step.status === "completed")}
    />
  );
  const beatCard = (beat: WorkflowBeat) => {
    if (beat === pausedAt) {
      // The step's own card stays, so its transcript can be read before resuming.
      return (
        <div className="flex flex-col gap-3">
          {pause(beat.name, beat.attempts, beat.detail ?? run.detail)}
          {stepCard(beat)}
        </div>
      );
    }
    return stepCard(beat);
  };
  const stepCard = (beat: WorkflowBeat) => (
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
  const resultLines = workflowResultLines(run.result);
  const pausedApart = run.status === "paused" && pausedAt === null;
  const keys = new Set([
    ...(feed ?? []).flatMap((row) => (row.kind === "quick" ? [`quick:${row.steps[0]?.name}`] : [])),
    ...beats.map((beat) => `step:${beat.name}`),
    ...loose.map((question) => `question:${question.name}`),
    ...(pausedApart ? ["pause"] : []),
    ...(ended ? ["end"] : []),
  ]);
  // A run that finished opens on what it came to: its result when that says more than the last
  // answer, else the last agent's reply. The header already says it is done.
  const lastAnswer = beats.findLast((beat) => beat.kind === "ask" && beat.status === "completed");
  const answered = lastAnswer === undefined ? null : workflowAnswer(lastAnswer.result);
  const resultSaysMore =
    resultLines.length > 0 &&
    !(resultLines.length === 1 && answered !== null && resultLines[0]?.value === answered.choice);
  const latest = (found: ReadonlyArray<WorkflowBeat>) =>
    found.reduce<WorkflowBeat | undefined>(
      (best, beat) => (best === undefined || beat.endMs >= best.endMs ? beat : best),
      undefined,
    );
  const lastAgent = latest(
    beats.filter((beat) => beat.kind === "agent" && beat.status === "completed"),
  );
  const finishedFocus =
    run.status !== "completed" || resultSaysMore || lastAgent === undefined
      ? "end"
      : `step:${lastAgent.name}`;
  const focus =
    picked !== null && keys.has(picked)
      ? picked
      : feed === null
        ? null
        : ended
          ? finishedFocus
          : workflowFlowFocus({
              rows: feed,
              status: run.status,
              ended,
              questions: node.questions.map((question) => question.name),
            });
  const pick = (key: string) => {
    const asks =
      key.startsWith("question:") ||
      beats.some((beat) => `step:${beat.name}` === key && questionOf(beat) !== null);
    setPicked(asks ? null : key);
    // Below the flow on a narrow page, so picking a step brings what it shows into view; a
    // question is answered where it is, so the page stays put.
    if (!asks) panel.current?.scrollIntoView({ block: "nearest" });
  };
  const endWord =
    run.status === "completed"
      ? gt("Finished", { $context: "how a workflow run ended" })
      : run.status === "stopped"
        ? gt("Stopped", { $context: "how a workflow run ended" })
        : run.status === "skipped"
          ? gt("Skipped", { $context: "how a workflow run ended" })
          : gt("Cancelled", { $context: "how a workflow run ended" });
  // A question is answered where it was asked, so beside it is what led up to it.
  const asking =
    focus !== null &&
    (focus.startsWith("question:") ||
      beats.some(
        (beat) =>
          `step:${beat.name}` === focus &&
          // Answered, its question is gone a moment before the step itself says it is done.
          (questionOf(beat) !== null || (beat.kind === "ask" && beat.status === "running")),
      ));
  // The latest agent's reply is what a person weighs before answering; failing that, the last
  // step that left something behind. A sleep or a wait has nothing to say.
  const before = asking
    ? (latest(beats.filter((beat) => beat.kind === "agent" && beat.status !== "running")) ??
      beats.findLast(
        (beat) =>
          beat.status !== "running" &&
          beat.kind !== "ask" &&
          beat.kind !== "sleep" &&
          beat.kind !== "wait",
      ) ??
      null)
    : null;
  const shown = asking ? (before === null ? null : `step:${before.name}`) : focus;
  const shownBeat = beats.find((beat) => `step:${beat.name}` === shown);
  const shownQuick = (feed ?? []).find(
    (row) => row.kind === "quick" && `quick:${row.steps[0]?.name}` === shown,
  );

  return (
    <article
      aria-label={run.title}
      className="mx-auto flex w-full max-w-5xl min-w-0 flex-col px-5 pt-5 pb-10"
    >
      <header className="space-y-1">
        <Button
          size="sm"
          variant="ghost"
          className="-ms-2.5 md:hidden"
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
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-base font-semibold break-words">{run.title}</h2>
          <WorkflowStateWord node={node} />
          {ended ? null : (
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={busy || !canCancel}
              title={gt("Cancel run")}
              onClick={() => void cancelRun()}
            >
              <SquareIcon className="size-2.5 fill-current" />
              {gt("Stop")}
            </Button>
          )}
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
          {run.status === "paused" ? null : (
            <>
              <span aria-hidden>·</span>
              <span>
                {ended
                  ? gt("took {duration}", { duration: formatDuration(ranMs) })
                  : gt("{duration} so far", { duration: formatDuration(ranMs) })}
              </span>
            </>
          )}
          {run.retired ? (
            <>
              <span aria-hidden>·</span>
              <span>
                <T>its version is no longer registered</T>
              </span>
            </>
          ) : null}
        </p>
        {references.length === 0 ? null : (
          <ul aria-label={gt("What the run touched")} className="flex flex-wrap gap-1.5 pt-1.5">
            {references.map((reference) => (
              <li key={`${reference.kind}:${reference.key}`} className="min-w-0">
                {chip(reference, reference.title !== "" && run.title.includes(reference.title))}
              </li>
            ))}
          </ul>
        )}
      </header>

      {detail.error ||
      feed === null ||
      (feed.length === 0 && run.status === "paused" && loose.length === 0) ? (
        <>
          {detail.error ? (
            <p className="mt-4 text-xs text-destructive">{detail.error}</p>
          ) : feed === null ? (
            <p className="mt-4 text-xs text-muted-foreground" role="status">
              <T>Loading steps…</T>
            </p>
          ) : null}
          {/* A question the run already asks is answerable without its step history. */}
          {run.status === "paused" ? (
            <div className="mt-4 border-t border-border pt-4">
              <div className="max-w-2xl">{pause(null, run.pauses, run.detail)}</div>
            </div>
          ) : null}
          {node.questions.map((question) => (
            <div key={question.name} className="mt-4">
              <WorkflowQuestionCard
                environmentId={environmentId}
                question={question}
                onOpenThread={onOpenThread}
              />
            </div>
          ))}
        </>
      ) : (
        <div className="mt-4 flex flex-col gap-4 @2xl/feed:flex-row @2xl/feed:items-start">
          <WorkflowTimeline
            environmentId={environmentId}
            rows={feed}
            node={node}
            nowMs={nowMs}
            // Only a step someone picked is marked; what the panel follows on its own is not.
            focus={picked !== null && keys.has(picked) ? picked : null}
            current={shown}
            onPick={pick}
            loose={loose}
            paused={pausedApart}
            end={ended ? endWord : null}
            question={questionOf}
            onOpenThread={onOpenThread}
            openedAtMs={openedAtMs}
          />
          <section
            ref={panel}
            aria-label={gt("What happened")}
            className="min-w-0 flex-1 border-t border-border pt-4 @2xl/feed:sticky @2xl/feed:top-4 @2xl/feed:self-stretch @2xl/feed:border-t-0 @2xl/feed:border-s @2xl/feed:ps-6 @2xl/feed:pt-1"
          >
            {shownBeat !== undefined ? (
              // Keyed by the step: a reason typed for one question must not follow to the next.
              <div key={shownBeat.name} data-step={shownBeat.name}>
                {beatCard(shownBeat)}
                {(() => {
                  // With one reference, the header already says it.
                  const touched =
                    references.length > 1 ? workflowStepReferences(references, shownBeat.name) : [];
                  return touched.length === 0 ? null : (
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {touched.map((reference) => chip(reference, true))}
                    </div>
                  );
                })()}
              </div>
            ) : shownQuick !== undefined && shownQuick.kind === "quick" ? (
              <WorkflowQuickStepsCard row={shownQuick} />
            ) : asking ? null : focus === "pause" ? (
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
                  <p className="mt-3 text-sm break-words whitespace-pre-wrap">{run.detail}</p>
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

// The first line of prose, so a reply that opens with a heading or a list still reads as a sentence.
const firstSentence = (text: string) => {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate !== "" && !/^(#|```|\|)/.test(candidate))
      ?.replace(/^([-*>]|\d+\.)\s+/, "") ?? "";
  // One line of plain text: inline code, emphasis and links read as their words.
  const plain = line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/g, "$2");
  const end = plain.search(/[.!?](\s|$)/);
  return end === -1 ? plain : plain.slice(0, end + 1);
};

type StepTone = "working" | "input" | "quiet" | "done" | "failed" | "ended";

/** A step's time in one shape down the column: 0.3s, 9.7s, 12s, then minutes. */
const stepTime = (ms: number) =>
  ms < 10_000 && ms % 1000 !== 0
    ? `${(Math.max(ms, 100) / 1000).toFixed(1)}s`
    : ms < 60_000
      ? `${Math.round(ms / 1000)}s`
      : formatDuration(ms);

// Colour says what is live: blue for work under way, amber for a person's turn. Done is quiet.
const RING: Record<StepTone, string> = {
  working: "stroke-info",
  input: "stroke-warning",
  quiet: "stroke-muted-foreground/60",
  done: "stroke-muted-foreground/45",
  failed: "stroke-destructive",
  ended: "stroke-muted-foreground/60",
};

const VERB_TONE = {
  working: "text-info-foreground",
  input: "text-warning-foreground",
  quiet: "text-muted-foreground",
  failed: "text-destructive",
} as const;

/**
 * A step's place on the rail: a ring, filled while it works, ticked when it is done. `pulse` and
 * `draw` never change for a step, so each plays once, when its part of the mark first appears.
 */
function StepMark({
  tone,
  pulse,
  draw,
}: {
  readonly tone: StepTone;
  /** It started while the run was open here. */
  readonly pulse: boolean;
  /** It ended while the run was open here. */
  readonly draw: boolean;
}) {
  const live = tone === "working" || tone === "input";
  return (
    <span aria-hidden className="relative z-10 grid size-5 shrink-0 place-items-center">
      {live && pulse ? (
        <span
          className={cn(
            "absolute inset-0.5 rounded-full border-2 opacity-0 motion-safe:animate-step-ping",
            tone === "input" ? "border-warning" : "border-info",
          )}
        />
      ) : null}
      <svg viewBox="0 0 20 20" className="size-5 overflow-visible">
        <circle
          cx="10"
          cy="10"
          r="8.2"
          strokeWidth="1.6"
          strokeDasharray={tone === "input" ? "2.6 2.2" : undefined}
          className={cn("fill-background", RING[tone])}
        />
        {live || tone === "quiet" ? (
          <circle
            cx="10"
            cy="10"
            r="3.4"
            className={
              tone === "input"
                ? "fill-warning"
                : tone === "quiet"
                  ? "fill-muted-foreground/60"
                  : "fill-info"
            }
          />
        ) : tone === "done" ? (
          <path
            d="M6.3 10.3l2.5 2.4 4.9-5"
            fill="none"
            strokeWidth={1.8}
            strokeDasharray="12"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
              "stroke-muted-foreground",
              draw ? "motion-safe:animate-check-draw" : null,
            )}
          />
        ) : tone === "failed" ? (
          <path
            d="M10 6.2v4.6M10 13.6v.1"
            fill="none"
            strokeWidth={1.8}
            strokeLinecap="round"
            className="stroke-destructive"
          />
        ) : (
          <path
            d="M6.6 10h6.8"
            fill="none"
            strokeWidth={1.6}
            strokeLinecap="round"
            className="stroke-muted-foreground"
          />
        )}
      </svg>
    </span>
  );
}

/** One line of the run: its mark on the rail, name, what it is doing, a word on how it went, its time. */
function TimelineRow({
  tone,
  enters,
  draw,
  lead,
  name,
  note,
  verb,
  verbTone = "working",
  aside,
  asideTone,
  duration,
  selected,
  current = false,
  onPick,
  sub = false,
}: {
  readonly tone: StepTone;
  /** It started while the run was open here, so it arrives instead of just being there. */
  readonly enters: boolean;
  /** It ended while the run was open here. */
  readonly draw: boolean;
  /** A small mark before the name, such as the agent's provider. */
  readonly lead?: ReactNode;
  readonly name: string;
  /** A quieter word after the name, such as the agent's model. */
  readonly note?: string | null;
  readonly verb?: string | null;
  readonly verbTone?: keyof typeof VERB_TONE;
  readonly aside?: string | null;
  readonly asideTone?: "failed";
  readonly duration?: string | null;
  readonly selected: boolean;
  /** The pane beside the timeline shows it. */
  readonly current?: boolean;
  readonly onPick: () => void;
  /** A step of a fork, hanging off the branch rather than the rail. */
  readonly sub?: boolean;
}) {
  const live = tone === "working" || tone === "input";
  return (
    <button
      type="button"
      aria-current={selected}
      className={cn(
        "group/row relative flex w-full min-w-0 cursor-pointer items-center gap-2.5 pe-2 text-left",
        sub ? "py-1 ps-1" : "py-1.5",
        enters ? "motion-safe:animate-step-in" : null,
      )}
      onClick={onPick}
    >
      {/* The highlight starts past the mark, so the rail and the branch stay whole. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 end-0 rounded-lg",
          "start-6",
          selected ? "bg-accent" : "group-hover/row:bg-accent/60",
        )}
      />
      {sub ? (
        <span aria-hidden className="relative z-10 grid size-5 shrink-0 place-items-center">
          <span
            className={cn(
              "size-2.5 rounded-full border-2",
              tone === "done"
                ? "border-transparent bg-muted-foreground/45"
                : tone === "failed"
                  ? "border-destructive bg-destructive"
                  : tone === "input"
                    ? "border-warning bg-warning"
                    : tone === "working"
                      ? "border-info bg-info"
                      : "border-muted-foreground/50 bg-background",
            )}
          />
        </span>
      ) : (
        <StepMark tone={tone} pulse={enters} draw={draw} />
      )}
      {/* Read left to right: the step, then what came of it. The name keeps its room. */}
      <span className="relative flex min-w-0 flex-1 items-baseline gap-2">
        <span className="flex max-w-[60%] min-w-0 shrink-0 items-baseline gap-1.5">
          {lead === undefined ? null : <span className="self-center">{lead}</span>}
          <span
            className={cn(
              "min-w-0 truncate text-sm",
              live || selected || current ? "font-medium text-foreground" : "text-foreground/75",
            )}
          >
            {name}
          </span>
        </span>
        {note || aside ? (
          <span
            className={cn(
              "min-w-0 truncate text-xs",
              asideTone === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {aside ?? note}
          </span>
        ) : null}
      </span>
      {verb ? (
        <span className={cn("relative max-w-[40%] shrink-0 truncate text-xs", VERB_TONE[verbTone])}>
          {verb}
        </span>
      ) : null}
      <span className="relative min-w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {duration ?? ""}
      </span>
      {/* Points at the pane beside the timeline; no background moves on its own. */}
      <span aria-hidden className="relative hidden w-3 shrink-0 place-items-center @2xl/feed:grid">
        {selected || current ? (
          <ChevronRightIcon
            className={cn("size-3", selected ? "text-foreground" : "text-muted-foreground")}
          />
        ) : null}
      </span>
    </button>
  );
}

/** The rail beside a row: from the row above to this mark, and on to the next unless it is last. */
function Rail({ first, last }: { readonly first: boolean; readonly last: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute start-[9px] w-0.5 bg-border",
        first ? "top-4" : "top-0",
        last ? "h-4" : "bottom-0",
        first && last ? "hidden" : null,
      )}
    />
  );
}

// A fork leaves the rail under its mark, runs through each step's dot, and rejoins the rail.
// The rail's centre is 10px in and a step's dot 39px in; the mark ends 26px down, the first dot
// sits 46px down, and each dot is 14px below its own row's top.
function BranchOut() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 32 20"
      className="pointer-events-none absolute start-[9px] top-[26px] h-5 w-8 overflow-visible"
    >
      <path
        d="M1 0V1Q1 7 7 7H24Q30 7 30 13V20"
        fill="none"
        strokeWidth={2}
        className="stroke-border"
      />
    </svg>
  );
}

function BranchBack() {
  return (
    <>
      <svg
        aria-hidden
        viewBox="0 0 32 14"
        className="pointer-events-none absolute -start-4 top-3.5 h-3.5 w-8 overflow-visible"
      >
        <path
          d="M30 0Q30 7 24 7H7Q1 7 1 13V14"
          fill="none"
          strokeWidth={2}
          className="stroke-border"
        />
      </svg>
      <span
        aria-hidden
        className="pointer-events-none absolute -start-4 top-7 bottom-0 w-0.5 bg-border"
      />
    </>
  );
}

/**
 * The run as it went, one line per step that took time or involved someone. Steps that ran at once
 * hang off a branch. It never draws what comes next: a run can branch, so the rail just goes on.
 */
function WorkflowTimeline({
  environmentId,
  rows,
  node,
  nowMs,
  focus,
  onPick,
  loose,
  paused,
  end,
  question,
  onOpenThread,
  openedAtMs,
  current,
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
  /** What it ended with, in a few words. */
  /** The question a step waits on a person for, answered right under it. */
  readonly question: (beat: WorkflowBeat) => WorkflowQuestion | null;
  readonly onOpenThread: (thread: WorkflowThreadTarget) => void;
  /** When this run was opened here: only what changes after that arrives with motion. */
  readonly openedAtMs: number;
  /** What the pane beside the timeline shows. */
  readonly current: string | null;
}) {
  const gt = useGT();
  const completed = node.run.status === "completed";
  const ask = (asked: WorkflowQuestion) => (
    <div className="ms-8 mt-1 mb-2">
      <WorkflowQuestionCard
        environmentId={environmentId}
        question={asked}
        onOpenThread={onOpenThread}
        inline
      />
    </div>
  );
  const beatRow = (beat: WorkflowBeat, sub = false) => (
    <WorkflowBeatRow
      environmentId={environmentId}
      beat={beat}
      child={node.children.find((child) => child.run.runId === beat.childRun?.runId) ?? null}
      asks={node.questions.some((asked) => asked.name === beat.name)}
      nowMs={nowMs}
      selected={focus === `step:${beat.name}`}
      current={current === `step:${beat.name}`}
      onPick={() => onPick(`step:${beat.name}`)}
      sub={sub}
      openedAtMs={openedAtMs}
    />
  );
  const items: Array<{
    readonly key: string;
    readonly body: ReactNode;
    /** Its steps hang off a branch, which carries the rail past them. */
    readonly branch?: boolean;
  }> = [];
  for (const row of rows) {
    if (row.kind === "quick") {
      const key = `quick:${row.steps[0]?.name}`;
      // Keyed by its first step, as that step's own row was, so regrouping does not remount it.
      const itemKey = row.steps[0]?.name ?? key;
      const names = row.steps.map((step) => step.name);
      items.push({
        key: itemKey,
        body: (
          <TimelineRow
            tone="done"
            // A finished step's own row turns into this one, so it is already there.
            enters={false}
            draw={row.endMs > openedAtMs}
            name={
              names.length <= 2
                ? names.join(" · ")
                : gt("{names} and {count} more", {
                    names: names.slice(0, 2).join(" · "),
                    count: names.length - 2,
                  })
            }
            duration={stepTime(Math.max(0, row.endMs - row.startMs))}
            selected={focus === key}
            current={current === key}
            onPick={() => onPick(key)}
          />
        ),
      });
      continue;
    }
    if (row.kind === "together") {
      const running = row.beats.filter((beat) => beat.status === "running").length;
      // Steps that only sleep or wait are under way without working.
      const working = row.beats.some(
        (beat) => beat.status === "running" && beat.kind !== "sleep" && beat.kind !== "wait",
      );
      const failed = row.beats.some((beat) => beat.status === "failed");
      const asks = row.beats.some(
        (beat) => beat.status === "running" && node.questions.some((q) => q.name === beat.name),
      );
      const startMs = Math.min(...row.beats.map((beat) => beat.startMs));
      const endMs = Math.max(...row.beats.map((beat) => beat.endMs));
      const first = row.beats[0];
      items.push({
        key: first?.name ?? "together",
        branch: true,
        body: (
          <>
            <div className="flex items-center gap-2.5 py-1.5 pe-2">
              <StepMark
                tone={
                  asks
                    ? "input"
                    : working
                      ? "working"
                      : running > 0
                        ? "quiet"
                        : failed
                          ? "failed"
                          : "done"
                }
                pulse={startMs > openedAtMs}
                draw={running === 0 && endMs > openedAtMs}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  running > 0 ? "font-medium" : "text-muted-foreground",
                )}
              >
                {gt("{count} in parallel", { count: row.beats.length })}
              </span>
              {working ? (
                <span className="text-xs text-info-foreground">
                  {gt("{count} running", { count: running })}
                </span>
              ) : null}
              <span className="min-w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {stepTime(running > 0 ? wholeSeconds(endMs - startMs) : endMs - startMs)}
              </span>
              <span aria-hidden className="hidden w-3 shrink-0 @2xl/feed:block" />
            </div>
            <BranchOut />
            <ol className="relative ms-[9px] ps-4">
              {row.beats.map((beat, index) => {
                const firstBeat = index === 0;
                const lastBeat = index === row.beats.length - 1;
                const asked = question(beat);
                return (
                  <li key={beat.name} className="relative">
                    <span
                      aria-hidden
                      className={cn(
                        "pointer-events-none absolute start-[13px] w-0.5 bg-border",
                        firstBeat ? "top-3.5" : "top-0",
                        lastBeat ? "h-3.5" : "bottom-0",
                        firstBeat && lastBeat ? "hidden" : null,
                      )}
                    />
                    {lastBeat ? <BranchBack /> : null}
                    {beatRow(beat, true)}
                    {asked === null ? null : ask(asked)}
                  </li>
                );
              })}
            </ol>
          </>
        ),
      });
      continue;
    }
    const asked = question(row);
    items.push({
      key: row.name,
      body: (
        <>
          {beatRow(row)}
          {asked === null ? null : ask(asked)}
        </>
      ),
    });
  }
  for (const asked of loose) {
    // Keyed like its step's row, which replaces it once the step arrives, so it does not arrive twice.
    items.push({
      key: asked.name,
      body: (
        <>
          <TimelineRow
            tone="input"
            enters={Date.parse(asked.askedAt) > openedAtMs}
            draw={false}
            name={asked.name}
            verb={gt("Asks you", { $context: "a workflow step waits on a person's answer" })}
            verbTone="input"
            selected={focus === `question:${asked.name}`}
            current={current === `question:${asked.name}`}
            onPick={() => onPick(`question:${asked.name}`)}
          />
          {ask(asked)}
        </>
      ),
    });
  }
  if (paused) {
    items.push({
      key: "pause",
      body: (
        <TimelineRow
          tone="failed"
          enters={false}
          draw={false}
          name={gt("Paused", { $context: "a workflow run is paused" })}
          aside={null}
          selected={focus === "pause"}
          current={current === "pause"}
          onPick={() => onPick("pause")}
        />
      ),
    });
  }
  // A finished run needs no closing row: the header says so, and the last step is the end.
  if (end !== null && !completed) {
    const endedMs = Date.parse(node.run.endedAt ?? node.run.updatedAt);
    items.push({
      key: "end",
      body: (
        <TimelineRow
          tone="ended"
          enters={endedMs > openedAtMs}
          draw={false}
          name={end}
          aside={node.run.detail}
          selected={focus === "end"}
          current={current === "end"}
          onPick={() => onPick("end")}
        />
      ),
    });
  }
  const live = end === null;
  return (
    <nav aria-label={gt("Steps so far")} className="w-full shrink-0 @2xl/feed:w-96">
      <ol>
        {items.map((item, index) => (
          <li key={item.key} className="relative">
            <Rail
              first={index === 0}
              last={item.branch === true || (index === items.length - 1 && !live)}
            />
            {item.body}
          </li>
        ))}
      </ol>
      {live ? (
        <div className="flex items-start gap-2.5">
          <span
            aria-hidden
            className="ms-[9px] block h-5 w-0 border-s-2 border-dashed border-border"
          />
        </div>
      ) : null}
    </nav>
  );
}

function WorkflowBeatRow({
  environmentId,
  beat,
  child,
  asks,
  nowMs,
  selected,
  onPick,
  sub,
  openedAtMs,
  current,
}: {
  readonly environmentId: EnvironmentId;
  readonly beat: WorkflowBeat;
  readonly child: WorkflowRunNode | null;
  /** A person's answer is what it waits for. */
  readonly asks: boolean;
  readonly nowMs: number;
  readonly selected: boolean;
  readonly onPick: () => void;
  readonly sub: boolean;
  readonly openedAtMs: number;
  readonly current: boolean;
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
  const said = workflowAgentSummary(beat).said;
  const answer = beat.kind === "ask" ? workflowAnswer(beat.result) : null;
  const wakes = beat.detail === null ? Number.NaN : Date.parse(beat.detail);
  // An agent's own approval or question needs a person as much as the workflow's does.
  const agentAsks =
    beat.kind === "agent" && under && shell !== null
      ? shell.hasPendingUserInput
        ? gt("Asks you", { $context: "a workflow step waits on a person's answer" })
        : shell.hasPendingApprovals
          ? gt("waits for your approval")
          : null
      : null;
  // A question waits on a person until its step ends, answered or not; the list of open
  // questions drops it a moment before the step reports done.
  const needsYou = (under && (asks || beat.kind === "ask")) || agentAsks !== null;
  const model = shell === null ? null : formatModelSlugName(shell.modelSelection.model);
  const verb = (() => {
    if (!under) return null;
    if (agentAsks !== null) return agentAsks;
    switch (beat.kind) {
      case "agent":
        return shell?.runtime?.status === "preparing" || shell?.runtime?.status === "starting"
          ? gt("starting")
          : gt("working");
      case "ask":
        // Without its question it was just answered, and the step is about to say so.
        return asks
          ? gt("Asks you", { $context: "a workflow step waits on a person's answer" })
          : null;
      case "sleep":
        return Number.isFinite(wakes) && wakes > nowMs
          ? gt("wakes in {duration}", { duration: formatDuration(wholeSeconds(wakes - nowMs)) })
          : gt("about to wake");
      case "wait":
        return gt("waiting");
      case "run":
        return child === null ? gt("running") : workflowRunNow(child, m);
      case "step":
        return gt("running");
    }
  })();
  const aside = (() => {
    if (failed) return firstSentence(beat.detail ?? gt("failed"));
    if (under) return null;
    switch (beat.kind) {
      case "agent":
        return said === null ? null : firstSentence(said);
      case "ask":
        return answer === null
          ? gt("nobody answered")
          : gt("You said {choice}", { choice: answer.choice });
      case "sleep":
      case "wait":
        return null;
      case "run":
        return child === null ? null : workflowRunNow(child, m);
      case "step": {
        const first = workflowResultLines(beat.result)[0];
        return first === undefined
          ? null
          : first.label === null
            ? first.value
            : `${first.label}: ${first.value}`;
      }
    }
  })();

  return (
    <TimelineRow
      tone={
        failed
          ? "failed"
          : needsYou
            ? "input"
            : under
              ? beat.kind === "sleep" || beat.kind === "wait"
                ? "quiet"
                : "working"
              : "done"
      }
      enters={beat.startMs > openedAtMs}
      draw={!under && beat.endMs > openedAtMs}
      lead={
        beat.kind === "agent" && provider !== undefined ? (
          <ProviderInstanceIcon
            driverKind={provider.driver}
            displayName={provider.displayName ?? provider.instanceId}
            accentColor={provider.accentColor}
            size="compact"
          />
        ) : beat.kind === "run" ? (
          <WorkflowChip name={beat.childRun?.workflow ?? beat.name} />
        ) : undefined
      }
      name={beat.childRun?.title ?? beat.name}
      note={beat.kind === "agent" && (under || said === null) ? model : null}
      verb={verb}
      verbTone={
        needsYou ? "input" : beat.kind === "sleep" || beat.kind === "wait" ? "quiet" : "working"
      }
      aside={aside}
      {...(failed ? { asideTone: "failed" as const } : {})}
      duration={stepTime(elapsedOf(beat))}
      selected={selected}
      current={current}
      onPick={onPick}
      sub={sub}
    />
  );
}

// What happened reads as part of the page. A question, answered in the timeline, is the one box;
// a pause says so in its heading and its button.
const CARD_TONE = {
  plain: "",
  quiet: "",
  ask: "rounded-xl border border-warning/30 bg-warning-surface px-3 py-2.5",
  failed: "",
  done: "",
} as const;

function FeedCard({
  tone = "plain",
  label,
  reveal = false,
  children,
}: {
  readonly tone?: keyof typeof CARD_TONE;
  readonly label?: string;
  /** Scroll it into view when it first shows. */
  readonly reveal?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section
      ref={reveal ? revealOnMount : undefined}
      aria-label={label}
      className={cn("min-w-0", CARD_TONE[tone])}
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
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        {mark === null || mark === undefined ? null : (
          <span className="grid h-6 shrink-0 place-items-center">{mark}</span>
        )}
        <div className="min-w-0 flex-1 truncate text-base leading-6 font-semibold">{name}</div>
        {action === undefined || action === null ? null : <div className="shrink-0">{action}</div>}
      </div>
      {sub === undefined || sub === null || sub === "" ? null : (
        <div className="mt-0.5 text-xs break-words text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}

function ResultLines({
  lines,
}: {
  readonly lines: ReadonlyArray<{ readonly label: string | null; readonly value: string }>;
}) {
  if (lines.length === 0) return null;
  if (lines.every((line) => line.label === null)) {
    return (
      <div className="mt-3 space-y-1 text-sm">
        {lines.map((line) => (
          <p key={line.value} className="break-words whitespace-pre-wrap">
            {line.value}
          </p>
        ))}
      </div>
    );
  }
  return <Facts facts={lines.map((line) => ({ label: line.label ?? "", value: line.value }))} />;
}

/** What a step left behind, as a list of names and values. */
function Facts({
  facts,
}: {
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}) {
  return (
    <dl className="mt-3 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="truncate text-muted-foreground">{fact.label}</dt>
          <dd className="break-words whitespace-pre-wrap">{fact.value}</dd>
        </div>
      ))}
    </dl>
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
      <CardHead mark={null} name={label} sub={children} />
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
  const length = formatDuration(elapsedOf(beat));
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
        return <Note label={beat.name}>{`${gt("nobody answered")} · ${length}`}</Note>;
      return (
        <FeedCard label={beat.name}>
          <CardHead mark={null} name={beat.name} sub={length} />
          <p className="mt-3 text-sm">
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
      if (!under) return <Note label={beat.name}>{`${gt("slept")} · ${length}`}</Note>;
      const wakes = beat.detail === null ? Number.NaN : Date.parse(beat.detail);
      return (
        <FeedCard tone="quiet" label={beat.name}>
          <CardHead
            mark={<MoonIcon className="size-3.5 text-muted-foreground" />}
            name={beat.name}
            sub={
              Number.isFinite(wakes) && wakes > nowMs
                ? gt("wakes in {duration}", {
                    duration: formatDuration(wholeSeconds(wakes - nowMs)),
                  })
                : gt("about to wake")
            }
          />
        </FeedCard>
      );
    }
    case "wait":
      if (!under) return <Note label={beat.name}>{`${gt("waited")} · ${length}`}</Note>;
      return (
        <FeedCard tone="quiet" label={beat.name}>
          <CardHead
            mark={<HourglassIcon className="size-3.5 text-muted-foreground" />}
            name={beat.name}
            sub={gt("{duration} so far", { duration: length })}
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
          {beat.status === "failed" ? `${gt("failed")} · ${length}` : length}
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
  const length = formatDuration(elapsedOf(beat));
  const summary = workflowAgentSummary(beat);
  const start = summary.said === null ? null : workflowSaidStart(summary.said, SAID_SHOWN);
  const liveWord = !under
    ? null
    : shell?.hasPendingUserInput === true
      ? gt("Asks you", { $context: "a workflow step waits on a person's answer" })
      : shell?.hasPendingApprovals === true
        ? gt("waits for your approval")
        : shell?.runtime?.status === "preparing" || shell?.runtime?.status === "starting"
          ? gt("starting")
          : gt("working");
  const sub = [
    shell === null ? null : formatModelSlugName(shell.modelSelection.model),
    liveWord,
    length,
    beat.attempts > 1 ? nthTry(beat.attempts, m) : null,
    elsewhere
      ? gt("on {environment}", { environment: threadEnvironment?.label ?? threadEnvironmentId })
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <FeedCard label={beat.name}>
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
              variant={open ? "secondary" : "ghost-muted"}
              aria-pressed={open}
              onClick={() => beat.thread !== null && onOpenThread(beat.thread)}
            >
              {under
                ? gt("Watch live")
                : gt("Transcript", { $context: "button that opens an agent's thread" })}
              <ArrowUpRightIcon />
            </Button>
          )
        }
      />
      {beat.status === "failed" && beat.detail ? (
        <p className="mt-3 flex gap-1.5 text-sm text-destructive">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words whitespace-pre-wrap">{beat.detail}</span>
        </p>
      ) : null}
      {summary.said === null ? null : (
        // Set off from the head, so headings in the reply read as the agent's, not the page's.
        <div className="mt-3 border-t border-border/60 pt-3">
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
              {all ? gt("Show less") : gt("Show more")}
            </button>
          ) : null}
        </div>
      )}
      {summary.facts.length === 0 ? null : <Facts facts={summary.facts} />}
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
  kept,
}: {
  readonly run: WorkflowRun;
  /** The step it stopped at, when the steps say which. */
  readonly name: string | null;
  readonly attempts: number;
  readonly reason: string | null;
  readonly nowMs: number;
  readonly disabled: boolean;
  readonly onResume: () => void;
  /** Steps before it finished, and resuming keeps them. */
  readonly kept: boolean;
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
            <T>Resume</T>
          </Button>
        }
      />
      {reason ? <p className="mt-3 text-sm break-words whitespace-pre-wrap">{reason}</p> : null}
      {kept ? (
        <p className="mt-2 text-xs text-muted-foreground">
          <T>Only the failed step runs again; what finished before it is kept.</T>
        </p>
      ) : null}
    </FeedCard>
  );
}

function WorkflowQuestionCard({
  environmentId,
  question,
  onOpenThread,
  inline = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly question: WorkflowQuestion;
  readonly onOpenThread: (thread: WorkflowThreadTarget) => void;
  /** Under its step in the run, which already says that it asks. */
  readonly inline?: boolean;
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
      {inline ? null : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn("font-medium", WORKFLOW_TONE_CLASS.input)}>
            <T context="the workflow run waits on a person">Needs you</T>
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
      )}
      <h3 className={cn("text-sm font-semibold break-words", inline ? null : "mt-1")}>
        {view.title}
      </h3>
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
      </div>
      {reason === null || (question.thread !== null && reachable) ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {reason === null ? (
            <button
              type="button"
              disabled={busy}
              className="cursor-pointer hover:text-foreground disabled:cursor-default"
              onClick={() => setReason("")}
            >
              <T>Add a reason</T>
            </button>
          ) : null}
          {question.thread === null || !reachable ? null : (
            <button
              type="button"
              className="cursor-pointer hover:text-foreground"
              onClick={() => question.thread !== null && onOpenThread(question.thread)}
            >
              <T>Ask the agent first</T>
            </button>
          )}
        </div>
      ) : null}
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
