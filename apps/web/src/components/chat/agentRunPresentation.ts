/**
 * Pure presentation decisions for the agent-run card. Kept out of the component
 * so the chip budget, the status vocabulary, the truncation decisions and the
 * feed budget can be pinned by tests.
 */

import type { AgentRun, AgentRunFeedLine, AgentRunPhase } from "../../agentRuns.ts";

export type AgentRunStatusAtom = "spinner" | "check" | "cross" | "square";

export type AgentRunDensity = "full" | "compact";

/**
 * The one status vocabulary. Card text, `aria-label`s and tooltips all read
 * from here, so they cannot drift apart (D6). `stopping` is a view state, not a
 * derived phase — it lives in `agentRunStop.logic`, not on the run.
 */
export type AgentRunStatusKey = AgentRunPhase | "queued" | "stopping";

export interface AgentRunChip {
  readonly id: string;
  readonly label: string;
  readonly tone: "neutral" | "destructive";
  /**
   * Container-query classes that hide the chip when the *card* is narrow — the
   * card lives in a resizable pane and a 352px popover, both of which satisfy
   * every viewport breakpoint, so `sm:` never gated anything (A10/D5).
   *
   * Written as complete literals: Tailwind extracts class names statically.
   */
  readonly gateClassName: string;
}

/** Chips beyond this wrap the collapsed row, which breaks the timeline pitch. */
export const AGENT_RUN_CHIP_BUDGET = 3;

/** The tracker's rows are two lines tall, so they carry `failed` plus one chip. */
export const AGENT_RUN_COMPACT_CHIP_BUDGET = 2;

/**
 * A queued subagent is a live task: `queued` is deliberately not distinguished
 * from `running`.
 */
export function agentRunStatusAtom(phase: AgentRunPhase): AgentRunStatusAtom {
  switch (phase) {
    case "running":
      return "spinner";
    case "done":
      return "check";
    case "failed":
      return "cross";
    case "stopped":
      return "square";
  }
}

export function agentRunStatusLabel(status: AgentRunStatusKey): string {
  switch (status) {
    case "running":
      return "Running";
    case "queued":
      return "Queued";
    case "stopping":
      return "Stopping…";
    case "done":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

/**
 * Right-to-left drop order, so the least identifying number is the first thing
 * to go: tokens → tools → subagent. `failed` is never gated.
 */
const AGENT_RUN_CHIP_GATE: Readonly<Record<string, string>> = {
  failed: "",
  subagent: "hidden @[18rem]/agent-run:inline-flex",
  tools: "hidden @[22rem]/agent-run:inline-flex",
  tokens: "hidden @[26rem]/agent-run:inline-flex",
};

/** Highest-signal first, hard-capped at the density's budget. */
export function agentRunChips(
  run: AgentRun,
  density: AgentRunDensity = "full",
): ReadonlyArray<AgentRunChip> {
  const chips: AgentRunChip[] = [];
  if (run.phase === "failed") {
    chips.push({ id: "failed", label: "failed", tone: "destructive", gateClassName: "" });
  }
  // The subagent type is redundant when the title already shows it.
  if (run.subagentType && run.title !== run.subagentType) {
    chips.push(neutralChip("subagent", run.subagentType));
  }
  if (run.toolUses !== undefined && run.toolUses > 0) {
    chips.push(neutralChip("tools", `${run.toolUses} ${run.toolUses === 1 ? "tool" : "tools"}`));
  }
  if (run.totalTokens !== undefined && run.totalTokens > 0) {
    chips.push(neutralChip("tokens", `${formatCompactCount(run.totalTokens)} tokens`));
  }
  return chips.slice(
    0,
    density === "compact" ? AGENT_RUN_COMPACT_CHIP_BUDGET : AGENT_RUN_CHIP_BUDGET,
  );
}

function neutralChip(id: string, label: string): AgentRunChip {
  return { id, label, tone: "neutral", gateClassName: AGENT_RUN_CHIP_GATE[id] ?? "" };
}

/**
 * How many feed lines a card shows before "Show all N steps".
 *
 * The tracker popover stacks several rows, so a compact card shows the tail
 * only; the transcript card is where the full work log lives.
 */
export const AGENT_RUN_FEED_PREVIEW_LINES: Readonly<Record<AgentRunDensity, number>> = {
  full: 8,
  compact: 3,
};

export function visibleAgentRunFeedLines<T>(
  feed: ReadonlyArray<T>,
  density: AgentRunDensity,
  showAll = false,
): ReadonlyArray<T> {
  if (showAll) {
    return feed;
  }
  return feed.slice(-AGENT_RUN_FEED_PREVIEW_LINES[density]);
}

/** `null` when nothing is hidden — the card renders no expander in that case. */
export function agentRunFeedShowAllLabel(total: number, density: AgentRunDensity): string | null {
  return total > AGENT_RUN_FEED_PREVIEW_LINES[density] ? `Show all ${total} steps` : null;
}

/** `×3` for a coalesced line, `null` for one seen once. */
export function agentRunFeedRepeatLabel(repeat: number): string | null {
  return repeat > 1 ? `×${repeat}` : null;
}

/**
 * The full string a truncated feed line hides. `null` when there is nothing a
 * tooltip could add, so the card does not mount one per row for no reason (A5).
 */
export function agentRunFeedLineTooltip(line: AgentRunFeedLine): string | null {
  if (line.text.length === 0) {
    return null;
  }
  return line.tool === undefined ? line.text : `${line.tool} · ${line.text}`;
}

/**
 * The right-hand slot of the header row. Fixed width in the card, so this
 * function decides only *what* it says — one vocabulary, never a bare phase.
 */
export function agentRunElapsedLabel(input: {
  readonly phase: AgentRunPhase;
  readonly durationMs: number | undefined;
  readonly stopPending: boolean;
}): string | null {
  if (input.stopPending) {
    return agentRunStatusLabel("stopping");
  }
  const duration = formatAgentRunDuration(input.durationMs);
  if (input.phase === "running") {
    // The card mounts its own ticker here.
    return null;
  }
  return duration ?? agentRunStatusLabel(input.phase);
}

/**
 * Copy for the tracker's two-press "Stop all".
 *
 * The count moved out of the label and into {@link agentRunStopAllTooltip}: the
 * armed label used to be *wider* than the idle one (`Stop all (3)` →
 * `Stop 3 runs?`), so the destructive target moved between the two presses it
 * requires. Both labels now fit one fixed-width slot.
 *
 * (Deliberately here and not in `agentRunStop.logic.ts`: that module is the
 * behaviour of the stop request — this is its copy, and the redesign owns copy.)
 */
export function agentRunStopAllButtonLabel(armed: boolean): string {
  return armed ? "Confirm" : "Stop all";
}

export function agentRunStopAllTooltip(count: number, armed: boolean): string {
  const runs = `${count} ${count === 1 ? "run" : "runs"}`;
  return armed ? `Press again to stop ${runs}` : `Stop ${runs}`;
}

export function formatAgentRunDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatCompactCount(value: number): string {
  if (value < 1000) {
    return `${value}`;
  }
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
  }
  const millions = value / 1_000_000;
  return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`;
}
