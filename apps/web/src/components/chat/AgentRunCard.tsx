import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleStopIcon,
  CornerUpRightIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";

import type { AgentRun, AgentRunFeedLine } from "../../agentRuns.ts";
import { cn } from "~/lib/utils";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Group } from "../ui/group";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  agentRunChips,
  agentRunElapsedLabel,
  agentRunFeedLineTooltip,
  agentRunFeedRepeatLabel,
  agentRunFeedShowAllLabel,
  agentRunStatusAtom,
  agentRunStatusLabel,
  formatAgentRunDuration,
  visibleAgentRunFeedLines,
  type AgentRunDensity,
  type AgentRunStatusKey,
} from "./agentRunPresentation.ts";
// fork: f3 — per-task stop (increment 4)
import { useAgentRunStop } from "./agentRunStop.ts";
import { agentRunStopButtonState } from "./agentRunStop.logic.ts";

/**
 * One row per `taskId`: collapses the flat `task.*` work-log rows a subagent or
 * workflow emits into a single card.
 *
 * Both surfaces render *this* component — `full` is the transcript density and
 * `compact` is the tracker popover. The only differences are the ones in the
 * audit's density table: type scale, chip budget, feed budget, which body
 * sections exist, and whether a Jump control is offered.
 *
 * Layout contract of the header row (fixes the collapsing-title defect): the
 * title is the only child allowed to *grow*, keeps a `min-w-40` floor once the
 * card is wide enough for one, and the chips sit in a shrinkable, clipping
 * container that is gated on the **card's** width via `@container/agent-run` —
 * never on the viewport, which every desktop pane satisfies.
 */
export const AgentRunCard = memo(function AgentRunCard({
  run,
  density = "full",
  onJump,
}: {
  run: AgentRun;
  density?: AgentRunDensity;
  /** Compact rows only: the tracker owns the jump (and its miss handling). */
  onJump?: () => void;
}) {
  // Deviation from the audit's density table (which says "collapsed" for both):
  // a transcript card for a run that is live *at mount* opens its body, because
  // that is the only place the work log is visible at all and a settled card
  // that collapsed itself under the reader would be worse. A run that is
  // already settled when the row mounts (history) stays collapsed, so nothing
  // ever closes or opens under the user.
  const [expanded, setExpanded] = useState(() => density === "full" && run.phase === "running");
  // Keep the body mounted after the first open so re-expanding costs nothing.
  const [bodyEverOpened, setBodyEverOpened] = useState(
    () => density === "full" && run.phase === "running",
  );
  const chips = agentRunChips(run, density);
  // fork: f3 — the Stop control. Pending state is shared with the tracker's
  // "Stop all", so a card in the transcript reflects a press made in the pill.
  const stop = useAgentRunStop();
  const stopState = agentRunStopButtonState({
    run,
    requests: stop.requests,
    now: Date.now(),
    enabled: stop.enabled,
  });
  const stopPending = stopState === "pending";
  const statusKey: AgentRunStatusKey = stopPending ? "stopping" : run.phase;
  const elapsedLabel = agentRunElapsedLabel({
    phase: run.phase,
    durationMs: run.durationMs,
    stopPending,
  });
  const tail = run.feed.at(-1);

  // A failure is the one outcome worth opening unasked — and only once, so a
  // user who closes it again is not fought by the next re-render.
  const autoExpanded = useRef(false);
  useEffect(() => {
    if (run.phase !== "failed" || autoExpanded.current) {
      return;
    }
    autoExpanded.current = true;
    setBodyEverOpened(true);
    setExpanded(true);
  }, [run.phase]);

  return (
    <section
      aria-label={`${agentRunStatusLabel(statusKey)}: ${run.title}`}
      className="group/agent-run @container/agent-run -mx-1 px-1 py-0.5"
      data-agent-run={run.taskId}
      data-agent-run-density={density}
    >
      {/* fork: f3 — the header button is a single `<button>`, so the Stop
          control is a sibling in this row rather than nested inside it. */}
      <div className="flex w-full items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left leading-5 transition-colors duration-150 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => {
            setBodyEverOpened(true);
            setExpanded((previous) => !previous);
          }}
        >
          <AgentRunStatusGlyph phase={run.phase} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium text-foreground @[16rem]/agent-run:min-w-40",
              density === "compact" ? "text-xs" : "text-sm",
            )}
          >
            {run.title}
          </span>
          {chips.length > 0 ? (
            <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
              {chips.map((chip) => (
                <Badge
                  key={chip.id}
                  className={cn("shrink-0 font-normal tabular-nums", chip.gateClassName)}
                  size="sm"
                  variant={chip.tone === "destructive" ? "error" : "secondary"}
                >
                  {chip.label}
                </Badge>
              ))}
            </span>
          ) : null}
          {/* Fixed width: `9s → 10s → 1m → 1m 1s` used to shove the controls
              sideways once a second, in every card at once. */}
          <span className="w-14 shrink-0 truncate text-right text-muted-foreground text-xs tabular-nums">
            {elapsedLabel ?? <AgentRunElapsed createdAt={run.createdAt} />}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200",
              expanded && "rotate-180",
            )}
          />
        </button>
        <AgentRunRowControls
          run={run}
          stopPending={stopPending}
          stopVisible={stopState !== "hidden"}
          onStop={() => stop.stopRuns([run.taskId])}
          {...(onJump ? { onJump } : {})}
        />
      </div>
      {/* Compact rows are two lines: identity, then the coalesced tail of the
          feed. Expanding swaps it for the (still short) feed list. */}
      {density === "compact" && !expanded ? (
        tail !== undefined ? (
          <ul className="pl-5.5">
            <AgentRunFeedRow line={tail} live={run.phase === "running"} />
          </ul>
        ) : run.phase === "running" ? (
          <p className="pl-5.5 text-[11px] leading-5 text-muted-foreground/70">Starting…</p>
        ) : null
      ) : null}
      {bodyEverOpened ? (
        <div className={cn("pl-5.5 pt-1", expanded ? null : "hidden")}>
          <AgentRunBody run={run} density={density} />
        </div>
      ) : null}
    </section>
  );
});

/**
 * The trailing affordances, outside the header button so a disclosure press
 * cannot be mistaken for a destructive one. Order is fixed: Stop, then Jump.
 */
function AgentRunRowControls({
  run,
  stopVisible,
  stopPending,
  onStop,
  onJump,
}: {
  run: AgentRun;
  stopVisible: boolean;
  stopPending: boolean;
  onStop: () => void;
  onJump?: () => void;
}) {
  if (!stopVisible && onJump === undefined && !run.ambient) {
    return null;
  }
  return (
    <div className="flex shrink-0 items-center gap-1">
      {run.ambient ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge className="font-normal text-muted-foreground" size="sm" variant="secondary">
                background
              </Badge>
            }
          />
          <TooltipPopup className="max-w-64 text-balance">
            Housekeeping task — hidden from the transcript
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {stopVisible || onJump !== undefined ? (
        <Group className="opacity-0 transition-opacity focus-within:opacity-100 pointer-coarse:opacity-100 group-hover/agent-run:opacity-100">
          {stopVisible ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={`Stop ${run.title}`}
                    className="text-muted-foreground hover:text-destructive-foreground"
                    disabled={stopPending}
                    onClick={(event) => {
                      event.stopPropagation();
                      onStop();
                    }}
                    size="icon-xs"
                    variant="ghost"
                  >
                    {stopPending ? (
                      <Spinner aria-label="" className="size-3.5" />
                    ) : (
                      /* Never the bare square — that glyph already means
                         "this run was stopped" on the status side. */
                      <CircleStopIcon aria-hidden="true" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup>
                {stopPending ? agentRunStatusLabel("stopping") : "Stop this run"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {onJump !== undefined ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={`Jump to ${run.title} in the transcript`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation();
                      onJump();
                    }}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <CornerUpRightIcon aria-hidden="true" />
                  </Button>
                }
              />
              <TooltipPopup>Jump to transcript</TooltipPopup>
            </Tooltip>
          ) : null}
        </Group>
      ) : null}
    </div>
  );
}

/**
 * Body order is the exact inverse of the old card: the outcome first, the work
 * log next, and the bulk content (prompt, ids) behind disclosures.
 */
function AgentRunBody({ run, density }: { run: AgentRun; density: AgentRunDensity }) {
  const showDetails = density === "full";
  return (
    <div className="space-y-2 text-[11px] leading-5 text-muted-foreground/80">
      <AgentRunOutcome run={run} />
      <AgentRunFeed run={run} density={density} />
      {showDetails && run.prompt ? (
        <AgentRunDisclosure label="Delegated prompt">
          <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
            {run.prompt}
          </p>
        </AgentRunDisclosure>
      ) : null}
      {showDetails ? (
        <AgentRunDisclosure label="Details">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            <AgentRunMetadataRow label="Subagent" value={run.subagentType} />
            <AgentRunMetadataRow label="Workflow" value={run.workflowName} />
            <AgentRunMetadataRow label="Task type" value={run.taskType} />
            <AgentRunMetadataRow
              label="Tool uses"
              value={run.toolUses === undefined ? undefined : `${run.toolUses}`}
            />
            <AgentRunMetadataRow
              label="Tokens"
              value={run.totalTokens === undefined ? undefined : `${run.totalTokens}`}
            />
            <AgentRunMetadataRow
              label="Duration"
              value={formatAgentRunDuration(run.durationMs) ?? undefined}
            />
            {/* Last, and allowed to wrap: a 36-char id is never the answer to
                "what is this run doing". */}
            <AgentRunMetadataRow label="Task id" mono value={run.taskId} />
          </dl>
        </AgentRunDisclosure>
      ) : null}
      {run.detailsUnavailable ? (
        <p className="text-muted-foreground text-xs">Details unavailable for this restored run.</p>
      ) : null}
    </div>
  );
}

/** Failure first and unclamped-but-scrollable; success as a clamped summary. */
function AgentRunOutcome({ run }: { run: AgentRun }) {
  const [showFullSummary, setShowFullSummary] = useState(false);
  if (run.error) {
    return (
      <Alert className="px-2 py-1.5" variant="error">
        <AlertDescription>
          <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
            {run.error}
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  if (!run.summary) {
    return null;
  }
  return (
    <div>
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-foreground/80 text-xs",
          showFullSummary ? null : "line-clamp-6",
        )}
      >
        {run.summary}
      </p>
      {!showFullSummary && run.summary.length > 240 ? (
        <Button
          className="h-auto px-0 text-muted-foreground"
          onClick={() => setShowFullSummary(true)}
          size="xs"
          variant="link"
        >
          Show more
        </Button>
      ) : null}
    </div>
  );
}

function AgentRunFeed({ run, density }: { run: AgentRun; density: AgentRunDensity }) {
  const [showAll, setShowAll] = useState(false);
  if (run.feed.length === 0) {
    // The normal first state of every run: say so instead of showing an empty
    // expanded body.
    return run.phase === "running" ? (
      <p className="text-[11px] leading-5 text-muted-foreground/70">Starting…</p>
    ) : null;
  }
  const lines = visibleAgentRunFeedLines(run.feed, density, showAll);
  const showAllLabel = agentRunFeedShowAllLabel(run.feed.length, density);
  const tailId = run.feed.at(-1)?.id;
  return (
    <div>
      <ul className={cn("space-y-px", showAll ? "max-h-56 overflow-auto" : null)}>
        {lines.map((line) => (
          <AgentRunFeedRow
            key={line.id}
            line={line}
            live={run.phase === "running" && line.id === tailId}
          />
        ))}
      </ul>
      {showAllLabel !== null && !showAll ? (
        <Button
          className="h-auto px-0 text-muted-foreground"
          onClick={() => setShowAll(true)}
          size="xs"
          variant="link"
        >
          {showAllLabel}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * `[tool ·] text …… [×3] [•]` — the actor and the object are separated, and the
 * truncated object is recoverable through a Tooltip.
 */
const AgentRunFeedRow = memo(function AgentRunFeedRow({
  line,
  live,
}: {
  line: AgentRunFeedLine;
  live: boolean;
}) {
  const repeat = agentRunFeedRepeatLabel(line.repeat);
  const tooltip = agentRunFeedLineTooltip(line);
  return (
    <li className="flex min-w-0 items-center text-[11px] leading-5">
      {line.tool !== undefined ? (
        <span
          className={cn(
            "max-w-32 shrink-0 truncate font-medium",
            line.kind === "subagent" ? "text-foreground/70" : "text-muted-foreground/70",
          )}
        >
          {line.tool}
        </span>
      ) : null}
      {line.tool !== undefined && line.text.length > 0 ? (
        <span aria-hidden="true" className="mx-1 text-muted-foreground/40">
          ·
        </span>
      ) : null}
      {tooltip !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="min-w-0 flex-1 truncate text-muted-foreground/80">{line.text}</span>
            }
          />
          <TooltipPopup className="max-w-72 whitespace-normal text-balance">{tooltip}</TooltipPopup>
        </Tooltip>
      ) : (
        <span className="flex-1" />
      )}
      {live ? (
        <span
          aria-hidden="true"
          className="ml-1 size-1.5 shrink-0 animate-status-pulse rounded-full bg-primary motion-reduce:animate-none"
        />
      ) : repeat !== null ? (
        <span className="ml-1 shrink-0 text-muted-foreground/50 tabular-nums">{repeat}</span>
      ) : null}
    </li>
  );
});

function AgentRunDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button
            className="group/disclosure -ml-1 h-6 gap-1 px-1 font-normal text-muted-foreground"
            size="xs"
            variant="ghost"
          >
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3 transition-transform group-data-[panel-open]/disclosure:rotate-90"
            />
            {label}
          </Button>
        }
      />
      <CollapsiblePanel>
        <div className="pt-1">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function AgentRunMetadataRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | undefined;
  mono?: boolean;
}) {
  if (!value) {
    return null;
  }
  return (
    <>
      <dt className="text-muted-foreground/60">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-muted-foreground/80",
          mono ? "break-all font-mono text-[10px]" : "break-words",
        )}
      >
        {value}
      </dd>
    </>
  );
}

/**
 * A single pulsing dot while running — the app's own live glyph. The three
 * 4px dots it replaces read as a static "•••" ellipsis.
 */
function AgentRunStatusGlyph({ phase }: { phase: AgentRun["phase"] }) {
  const atom = agentRunStatusAtom(phase);
  if (atom === "spinner") {
    return (
      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
        <span className="size-1.5 animate-status-pulse rounded-full bg-primary motion-reduce:animate-none" />
      </span>
    );
  }
  const Icon = atom === "check" ? CheckIcon : atom === "cross" ? XIcon : SquareIcon;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center",
        atom === "check"
          ? "text-success-foreground"
          : atom === "cross"
            ? "text-destructive-foreground"
            : "text-muted-foreground",
      )}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

/**
 * Self-ticking elapsed label: writes its own text node so a running card does
 * not schedule a React commit every second. Anchored to the run's `createdAt`
 * so a remount does not reset it, only mounted while the run is running, and
 * suspended while the document is hidden.
 */
function AgentRunElapsed({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatElapsedNow(createdAt);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = formatElapsedNow(createdAt);
      }
    };
    const start = () => {
      update();
      timer ??= setInterval(update, 1000);
    };
    const stop = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const sync = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        start();
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [createdAt]);

  return <span ref={textRef}>{initialText}</span>;
}

function formatElapsedNow(createdAt: string): string {
  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) {
    return "";
  }
  return formatAgentRunDuration(Math.max(0, Date.now() - started)) ?? "0s";
}
