import { CheckIcon, ChevronDownIcon, SquareIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import type { AgentRun } from "../../agentRuns.ts";
import { cn } from "~/lib/utils";
import {
  agentRunChips,
  agentRunStatusAtom,
  agentRunStatusLabel,
  formatAgentRunDuration,
  visibleAgentRunFeedLines,
} from "./agentRunPresentation.ts";
// fork: f3 — per-task stop (increment 4)
import { useAgentRunStop } from "./agentRunStop.ts";
import { agentRunStopButtonState } from "./agentRunStop.logic.ts";

/**
 * One row per `taskId`: collapses the flat `task.*` work-log rows a subagent or
 * workflow emits into a single card.
 *
 * `full` is the transcript density; `compact` is for the tracker popover, where
 * only the feed stays always-on.
 */
export const AgentRunCard = memo(function AgentRunCard({
  run,
  density = "full",
}: {
  run: AgentRun;
  density?: "full" | "compact";
}) {
  // In the tracker popover the live feed is the whole point of the row, so a
  // compact card opens with its body already showing.
  const [expanded, setExpanded] = useState(density === "compact");
  // Keep the body mounted after the first open so re-expanding costs nothing.
  const [bodyEverOpened, setBodyEverOpened] = useState(density === "compact");
  const chips = agentRunChips(run);
  const staticDuration = formatAgentRunDuration(run.durationMs);
  // fork: f3 — the Stop control. Pending state is shared with the tracker's
  // "Stop all", so a card in the transcript reflects a press made in the pill.
  const stop = useAgentRunStop();
  const stopState = agentRunStopButtonState({
    run,
    requests: stop.requests,
    now: Date.now(),
    enabled: stop.enabled,
  });

  return (
    <section
      className="-mx-1 px-1 py-0.5"
      data-agent-run={run.taskId}
      aria-label={`${agentRunStatusLabel(run.phase)}: ${run.title}`}
    >
      {/* fork: f3 — the header button is a single `<button>`, so the Stop
          control is a sibling in this row rather than nested inside it. */}
      <div className="flex w-full items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          aria-expanded={expanded}
          onClick={() => {
            setBodyEverOpened(true);
            setExpanded((previous) => !previous);
          }}
        >
          <AgentRunStatusAtom phase={run.phase} />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground/82">
            {run.title}
          </span>
          {chips.map((chip) => (
            <span
              key={chip.id}
              className={cn(
                "hidden shrink-0 rounded px-1 py-px text-[10px] leading-4 sm:inline-block",
                chip.tone === "destructive"
                  ? "bg-destructive/12 text-destructive"
                  : "bg-muted/60 text-muted-foreground/80",
              )}
            >
              {chip.label}
            </span>
          ))}
          <span className="shrink-0 text-[11px] text-muted-foreground/65 tabular-nums">
            {/* fork: f3 — a requested stop replaces the ticking clock, so both
              densities show that the press landed. */}
            {stopState === "pending" ? (
              "Stopping…"
            ) : run.phase === "running" ? (
              <AgentRunElapsed createdAt={run.createdAt} />
            ) : (
              (staticDuration ?? "")
            )}
          </span>
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/65 opacity-70 transition-transform duration-200",
              expanded && "rotate-180",
            )}
          />
        </button>
        {stopState === "hidden" ? null : (
          <button
            type="button"
            aria-label={`Stop ${run.title}`}
            title={stopState === "pending" ? "Stopping…" : "Stop this agent run"}
            disabled={stopState === "pending"}
            className={cn(
              "shrink-0 rounded p-1 text-muted-foreground/70 transition-colors",
              "hover:bg-destructive/12 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
              stopState === "pending" ? "cursor-default opacity-50" : "cursor-pointer",
            )}
            onClick={(event) => {
              event.stopPropagation();
              stop.stopRuns([run.taskId]);
            }}
          >
            <SquareIcon aria-hidden="true" className="size-3" />
          </button>
        )}
      </div>
      {bodyEverOpened ? (
        <div className={cn("pl-6 pt-1", expanded ? null : "hidden")}>
          <AgentRunBody run={run} density={density} />
        </div>
      ) : null}
    </section>
  );
});

function AgentRunBody({ run, density }: { run: AgentRun; density: "full" | "compact" }) {
  const duration = formatAgentRunDuration(run.durationMs);
  const showMetadata = density === "full";
  const feed = visibleAgentRunFeedLines(run.feed, density);

  return (
    <div className="space-y-2 text-[11px] leading-5 text-muted-foreground/80">
      {run.detailsUnavailable ? (
        <p className="text-muted-foreground/65">Details unavailable for this restored run.</p>
      ) : null}
      {showMetadata ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          <AgentRunMetadataRow label="Task id" value={run.taskId} />
          <AgentRunMetadataRow label="Task type" value={run.taskType} />
          <AgentRunMetadataRow label="Subagent" value={run.subagentType} />
          <AgentRunMetadataRow label="Workflow" value={run.workflowName} />
          <AgentRunMetadataRow
            label="Tool uses"
            value={run.toolUses === undefined ? undefined : `${run.toolUses}`}
          />
          <AgentRunMetadataRow
            label="Tokens"
            value={run.totalTokens === undefined ? undefined : `${run.totalTokens}`}
          />
          <AgentRunMetadataRow label="Duration" value={duration ?? undefined} />
        </dl>
      ) : null}
      {showMetadata && run.prompt ? (
        <div>
          <p className="font-medium text-foreground/70">Delegated prompt</p>
          <p className="whitespace-pre-wrap break-words text-muted-foreground/75">{run.prompt}</p>
        </div>
      ) : null}
      {feed.length > 0 ? (
        <ul className="space-y-px">
          {feed.map((line) => (
            <li key={line.id} className="flex min-w-0 gap-1.5">
              {line.toolName ? (
                <span className="shrink-0 text-muted-foreground/60">{line.toolName}</span>
              ) : null}
              <span className="min-w-0 flex-1 truncate">{line.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {run.error ? (
        <p className="whitespace-pre-wrap break-words text-destructive">{run.error}</p>
      ) : run.summary ? (
        <p className="whitespace-pre-wrap break-words text-muted-foreground/75">{run.summary}</p>
      ) : null}
    </div>
  );
}

function AgentRunMetadataRow({ label, value }: { label: string; value: string | undefined }) {
  if (!value) {
    return null;
  }
  return (
    <>
      <dt className="text-muted-foreground/60">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-[10px] text-muted-foreground/80">
        {value}
      </dd>
    </>
  );
}

function AgentRunStatusAtom({ phase }: { phase: AgentRun["phase"] }) {
  const atom = agentRunStatusAtom(phase);
  if (atom === "spinner") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
        <span className="inline-flex items-center gap-[2px]">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:200ms]" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:400ms]" />
        </span>
      </span>
    );
  }
  const Icon = atom === "check" ? CheckIcon : atom === "cross" ? XIcon : SquareIcon;
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center",
        atom === "cross" ? "text-destructive" : "text-muted-foreground/65",
      )}
      aria-hidden="true"
    >
      <Icon className="size-3.5" />
    </span>
  );
}

/**
 * Self-ticking elapsed label: writes its own text node so a running card does
 * not schedule a React commit every second. Anchored to the run's `createdAt`
 * so a remount does not reset it, and only mounted while the run is running.
 */
function AgentRunElapsed({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatElapsedNow(createdAt);

  useEffect(() => {
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = formatElapsedNow(createdAt);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

function formatElapsedNow(createdAt: string): string {
  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) {
    return "";
  }
  return formatAgentRunDuration(Math.max(0, Date.now() - started)) ?? "0s";
}
