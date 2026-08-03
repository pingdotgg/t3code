/**
 * Pure presentation decisions for the agent-run card. Kept out of the component
 * so the chip budget and the status vocabulary can be pinned by tests.
 */

import type { AgentRun, AgentRunPhase } from "../../agentRuns.ts";

export type AgentRunStatusAtom = "spinner" | "check" | "cross" | "square";

export interface AgentRunChip {
  readonly id: string;
  readonly label: string;
  readonly tone: "neutral" | "destructive";
}

/** Chips beyond this wrap the collapsed row, which breaks the timeline pitch. */
export const AGENT_RUN_CHIP_BUDGET = 3;

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

export function agentRunStatusLabel(phase: AgentRunPhase): string {
  switch (phase) {
    case "running":
      return "Running";
    case "done":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

/** Highest-signal first, hard-capped at {@link AGENT_RUN_CHIP_BUDGET}. */
export function agentRunChips(run: AgentRun): ReadonlyArray<AgentRunChip> {
  const chips: AgentRunChip[] = [];
  if (run.phase === "failed") {
    chips.push({ id: "failed", label: "failed", tone: "destructive" });
  }
  // The subagent type is redundant when the title already shows it.
  if (run.subagentType && run.title !== run.subagentType) {
    chips.push({ id: "subagent", label: run.subagentType, tone: "neutral" });
  }
  if (run.toolUses !== undefined && run.toolUses > 0) {
    chips.push({
      id: "tools",
      label: `${run.toolUses} ${run.toolUses === 1 ? "tool" : "tools"}`,
      tone: "neutral",
    });
  }
  if (run.totalTokens !== undefined && run.totalTokens > 0) {
    chips.push({
      id: "tokens",
      label: `${formatCompactCount(run.totalTokens)} tokens`,
      tone: "neutral",
    });
  }
  return chips.slice(0, AGENT_RUN_CHIP_BUDGET);
}

/**
 * The tracker popover stacks several cards, so a compact card shows only the
 * tail of its feed — the whole feed is one click away at `full` density.
 */
export const AGENT_RUN_COMPACT_FEED_LINES = 5;

export function visibleAgentRunFeedLines<T>(
  feed: ReadonlyArray<T>,
  density: "full" | "compact",
): ReadonlyArray<T> {
  return density === "compact" ? feed.slice(-AGENT_RUN_COMPACT_FEED_LINES) : feed;
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
