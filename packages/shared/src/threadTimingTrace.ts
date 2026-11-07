import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type TimingSpanKind =
  | "queue"
  | "reasoning"
  | "assistant"
  | "tool"
  | "subagent"
  | "wait"
  | "other";

export type ThreadTimingSpan = {
  readonly id: string;
  readonly kind: TimingSpanKind;
  readonly label: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly status: OrchestrationV2TurnItem["status"] | "queued";
};

export type ThreadTimingTurn = {
  readonly runId: OrchestrationV2Run["id"];
  readonly ordinal: number;
  readonly label: string;
  readonly status: OrchestrationV2Run["status"];
  readonly requestedAtMs: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly queueWaitMs: number;
  readonly waitMs: number;
  readonly workMs: number;
  readonly spans: ReadonlyArray<ThreadTimingSpan>;
};

export type ThreadTimingTrace = {
  readonly originMs: number;
  readonly endMs: number;
  /** Wall-clock span from first request to last turn end (includes idle between turns). */
  readonly totalMs: number;
  /** Union of turn intervals; excludes idle gaps and counts overlaps once. */
  readonly activeMs: number;
  readonly queueWaitMs: number;
  readonly waitMs: number;
  readonly workMs: number;
  readonly turns: ReadonlyArray<ThreadTimingTurn>;
};

export type TimingRun = Pick<
  OrchestrationV2Run,
  | "id"
  | "ordinal"
  | "status"
  | "userMessageId"
  | "requestedAt"
  | "startedAt"
  | "completedAt"
  | "workStartedAt"
>;

export type TimingMessage = Pick<OrchestrationV2ConversationMessage, "id" | "role" | "text">;

/** Fields read for waterfall spans; streaming bodies may omit updatedAt. */
export type TimingTurnItem = {
  readonly id: OrchestrationV2TurnItem["id"];
  readonly type: OrchestrationV2TurnItem["type"];
  readonly runId: OrchestrationV2TurnItem["runId"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly title: OrchestrationV2TurnItem["title"];
  readonly startedAt: OrchestrationV2TurnItem["startedAt"];
  readonly completedAt: OrchestrationV2TurnItem["completedAt"];
  readonly updatedAt?: OrchestrationV2TurnItem["updatedAt"];
  readonly toolName?: string | null;
};

/** Boundaries and noise that are not timed work steps in the waterfall. */
const SKIP_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "user_message",
  "notification",
  "run_interrupt_request",
  "run_interrupt_result",
  "thread_created",
  "fork",
  "handoff",
]);

const WAIT_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "approval_request",
  "user_input_request",
  "secret_request",
  "link_request",
]);

function toEpochMs(value: DateTime.Utc | null | undefined): number | null {
  if (value == null) return null;
  const ms = DateTime.toEpochMillis(value);
  return Number.isFinite(ms) ? ms : null;
}

function spanKind(type: OrchestrationV2TurnItem["type"]): TimingSpanKind | null {
  if (SKIP_ITEM_TYPES.has(type)) return null;
  if (WAIT_ITEM_TYPES.has(type)) return "wait";
  if (type === "reasoning") return "reasoning";
  if (type === "assistant_message") return "assistant";
  if (type === "subagent") return "subagent";
  if (
    type === "command_execution" ||
    type === "file_change" ||
    type === "file_search" ||
    type === "web_search" ||
    type === "dynamic_tool"
  ) {
    return "tool";
  }
  return "other";
}

function spanLabel(item: TimingTurnItem): string {
  const title = item.title?.trim();
  if (title) return title;
  switch (item.type) {
    case "reasoning":
      return "Thinking";
    case "assistant_message":
      return "Reply";
    case "command_execution":
      return "Command";
    case "file_change":
      return "Edit";
    case "file_search":
      return "Search";
    case "web_search":
      return "Web search";
    case "dynamic_tool":
      return item.toolName ?? "Tool";
    case "subagent":
      return "Subagent";
    case "approval_request":
      return "Approval";
    case "user_input_request":
      return "Waiting for input";
    case "secret_request":
      return "Secret";
    case "link_request":
      return "Link environment";
    case "compaction":
      return "Compaction";
    case "checkpoint":
      return "Checkpoint";
    case "proposed_plan":
      return "Plan";
    case "todo_list":
      return "Tasks";
    case "system_notice":
      return "Notice";
    case "error":
      return "Error";
    default:
      return item.type.replaceAll("_", " ");
  }
}

function truncateLabel(text: string, max = 40): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(1, max - 1))}…`;
}

function turnLabel(run: TimingRun, messages: ReadonlyArray<TimingMessage> | undefined): string {
  const message = messages?.find(
    (candidate) => candidate.id === run.userMessageId && candidate.role === "user",
  );
  if (message?.text.trim()) return truncateLabel(message.text);
  return `Turn ${run.ordinal}`;
}

function itemEndMs(item: TimingTurnItem, nowMs: number): number | null {
  if (isOrchestrationV2WorkActive(item.status)) return nowMs;
  return toEpochMs(item.completedAt) ?? toEpochMs(item.updatedAt);
}

function isRunTimingLive(status: TimingRun["status"]): boolean {
  return (
    status === "queued" || status === "preparing" || status === "starting" || status === "running"
  );
}

function runEndMs(run: TimingRun, runItems: ReadonlyArray<TimingTurnItem>, nowMs: number): number {
  const completed = toEpochMs(run.completedAt);
  if (completed !== null) return completed;
  if (isRunTimingLive(run.status)) return nowMs;

  let latest = toEpochMs(run.startedAt) ?? toEpochMs(run.requestedAt) ?? nowMs;
  for (const item of runItems) {
    const end = itemEndMs(item, nowMs);
    if (end !== null && end > latest) latest = end;
  }
  return latest;
}

function sumDurationByKind(spans: ReadonlyArray<ThreadTimingSpan>, kind: TimingSpanKind): number {
  let total = 0;
  for (const span of spans) {
    if (span.kind === kind) total += span.durationMs;
  }
  return total;
}

/** Shared-time-axis placement for a waterfall bar. Tiny spans keep a visible sliver. */
export function timingBarPlacement(
  startMs: number,
  endMs: number,
  originMs: number,
  totalMs: number,
): { readonly offsetPct: number; readonly widthPct: number } {
  if (!(totalMs > 0)) return { offsetPct: 0, widthPct: 100 };
  const rawOffset = ((startMs - originMs) / totalMs) * 100;
  const offsetPct = Math.max(0, Math.min(100, rawOffset));
  const rawWidth = ((Math.max(endMs, startMs) - startMs) / totalMs) * 100;
  const widthPct = Math.min(100 - offsetPct, Math.max(1.5, rawWidth));
  return { offsetPct, widthPct };
}

export type FlameChartNode =
  | {
      readonly id: string;
      readonly kind: "turn";
      readonly runId: ThreadTimingTurn["runId"];
      readonly ordinal: number;
      readonly label: string;
      readonly startMs: number;
      readonly endMs: number;
      readonly durationMs: number;
      readonly depth: 0;
    }
  | {
      readonly id: string;
      readonly kind: TimingSpanKind;
      readonly runId: ThreadTimingTurn["runId"];
      readonly turnOrdinal: number;
      readonly spanId: string;
      readonly label: string;
      readonly startMs: number;
      readonly endMs: number;
      readonly durationMs: number;
      readonly depth: number;
      readonly status: ThreadTimingSpan["status"];
    };

export type FlameChartLayout = {
  readonly nodes: ReadonlyArray<FlameChartNode>;
  readonly maxDepth: number;
};

/**
 * Nest spans under longer containing spans (flame-chart depth). Turns stay on
 * row 0 so turn boundaries stay readable while zooming.
 */
export function layoutThreadFlameChart(trace: ThreadTimingTrace): FlameChartLayout {
  const nodes: FlameChartNode[] = [];
  let maxDepth = 0;

  for (const turn of trace.turns) {
    nodes.push({
      id: `turn:${turn.runId}`,
      kind: "turn",
      runId: turn.runId,
      ordinal: turn.ordinal,
      label: turn.label,
      startMs: turn.requestedAtMs,
      endMs: turn.endMs,
      durationMs: turn.durationMs,
      depth: 0,
    });

    const depthById = new Map<string, number>();
    const ordered = turn.spans
      .slice()
      .sort(
        (left, right) =>
          right.durationMs - left.durationMs ||
          left.startMs - right.startMs ||
          left.id.localeCompare(right.id),
      );

    for (const span of ordered) {
      let parentDepth = 0;
      for (const candidate of ordered) {
        if (candidate.id === span.id) continue;
        const candidateDepth = depthById.get(candidate.id);
        if (candidateDepth === undefined) continue;
        // Any overlap (not only full containment) needs a deeper row so bars
        // and click targets do not stack on the same depth.
        const overlaps = candidate.startMs < span.endMs && span.startMs < candidate.endMs;
        if (overlaps) parentDepth = Math.max(parentDepth, candidateDepth);
      }
      const depth = parentDepth + 1;
      depthById.set(span.id, depth);
      maxDepth = Math.max(maxDepth, depth);
      nodes.push({
        id: span.id,
        kind: span.kind,
        runId: turn.runId,
        turnOrdinal: turn.ordinal,
        spanId: span.id,
        label: span.label,
        startMs: span.startMs,
        endMs: span.endMs,
        durationMs: span.durationMs,
        depth,
        status: span.status,
      });
    }
  }

  nodes.sort(
    (left, right) =>
      left.depth - right.depth ||
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      left.id.localeCompare(right.id),
  );

  return { nodes, maxDepth };
}

/** Visible window helpers for a zoomable timing chart. */
export function clampTimingViewWindow(
  startMs: number,
  durationMs: number,
  originMs: number,
  totalMs: number,
  minDurationMs = 50,
): { readonly startMs: number; readonly durationMs: number } {
  const span = Math.max(1, totalMs);
  const duration = Math.min(span, Math.max(minDurationMs, durationMs));
  const maxStart = originMs + span - duration;
  const start = Math.min(maxStart, Math.max(originMs, startMs));
  return { startMs: start, durationMs: duration };
}

export function timingViewZoomAt(
  viewStartMs: number,
  viewDurationMs: number,
  originMs: number,
  totalMs: number,
  anchorMs: number,
  factor: number,
  minDurationMs = 50,
): { readonly startMs: number; readonly durationMs: number } {
  const nextDuration = viewDurationMs / Math.max(0.01, factor);
  const ratio =
    viewDurationMs > 0 ? Math.min(1, Math.max(0, (anchorMs - viewStartMs) / viewDurationMs)) : 0;
  const nextStart = anchorMs - ratio * nextDuration;
  return clampTimingViewWindow(nextStart, nextDuration, originMs, totalMs, minDurationMs);
}

export type TimingAxisSegment = {
  readonly kind: "active" | "idle";
  readonly realStartMs: number;
  readonly realEndMs: number;
  readonly displayStartMs: number;
  readonly displayEndMs: number;
};

export type TimingIdleBreak = {
  readonly id: string;
  readonly afterTurnOrdinal: number;
  readonly beforeTurnOrdinal: number;
  readonly realStartMs: number;
  readonly realEndMs: number;
  readonly idleMs: number;
  readonly displayStartMs: number;
  readonly displayEndMs: number;
};

export type CompressedTimingAxis = {
  readonly displayTotalMs: number;
  readonly collapsedIdleMs: number;
  readonly segments: ReadonlyArray<TimingAxisSegment>;
  readonly breaks: ReadonlyArray<TimingIdleBreak>;
  readonly realToDisplay: (realMs: number) => number;
  readonly displayToReal: (displayMs: number) => number;
};

/**
 * Collapse long gaps between turns into short visual breaks so snooze / idle
 * does not dominate the flame chart, while still marking that the gap existed.
 */
export function buildCompressedTimingAxis(
  turns: ReadonlyArray<Pick<ThreadTimingTurn, "ordinal" | "requestedAtMs" | "endMs">>,
  options?: {
    readonly collapseAboveMs?: number;
    readonly breakDisplayMs?: number;
  },
): CompressedTimingAxis {
  if (turns.length === 0) {
    return {
      displayTotalMs: 1,
      collapsedIdleMs: 0,
      segments: [],
      breaks: [],
      realToDisplay: () => 0,
      displayToReal: () => 0,
    };
  }

  const ordered = turns
    .slice()
    .sort(
      (left, right) => left.requestedAtMs - right.requestedAtMs || left.ordinal - right.ordinal,
    );
  // Covered wall time only — overlapping turns must not inflate the axis.
  const coverageActiveMs = unionIntervalMs(
    ordered.map((turn) => ({
      startMs: turn.requestedAtMs,
      endMs: Math.max(turn.endMs, turn.requestedAtMs),
    })),
  );
  const collapseAboveMs = options?.collapseAboveMs ?? Math.max(3_000, coverageActiveMs * 0.15);
  // Wide enough at fit-zoom for a readable torn-paper void between turns.
  const breakDisplayMs =
    options?.breakDisplayMs ?? Math.min(10_000, Math.max(3_500, coverageActiveMs * 0.1));

  const segments: TimingAxisSegment[] = [];
  const breaks: TimingIdleBreak[] = [];
  let displayCursor = 0;
  let collapsedIdleMs = 0;
  let prevEndMs = ordered[0]!.requestedAtMs;

  for (let index = 0; index < ordered.length; index++) {
    const turn = ordered[index]!;
    const gapStart = prevEndMs;
    const gapEnd = turn.requestedAtMs;
    const gapMs = gapEnd - gapStart;

    if (gapMs > collapseAboveMs) {
      const displayStartMs = displayCursor;
      const displayEndMs = displayCursor + breakDisplayMs;
      segments.push({
        kind: "idle",
        realStartMs: gapStart,
        realEndMs: gapEnd,
        displayStartMs,
        displayEndMs,
      });
      breaks.push({
        id: `idle:${gapStart}:${gapEnd}`,
        afterTurnOrdinal: ordered[index - 1]?.ordinal ?? turn.ordinal,
        beforeTurnOrdinal: turn.ordinal,
        realStartMs: gapStart,
        realEndMs: gapEnd,
        idleMs: gapMs,
        displayStartMs,
        displayEndMs,
      });
      collapsedIdleMs += gapMs;
      displayCursor = displayEndMs;
    } else if (gapMs > 0) {
      segments.push({
        kind: "active",
        realStartMs: gapStart,
        realEndMs: gapEnd,
        displayStartMs: displayCursor,
        displayEndMs: displayCursor + gapMs,
      });
      displayCursor += gapMs;
    }

    // Clip to uncovered real time so overlaps are not mapped twice.
    const turnStart = Math.max(turn.requestedAtMs, prevEndMs);
    const turnEnd = Math.max(turn.endMs, turnStart);
    const turnDuration = turnEnd - turnStart;
    if (turnDuration > 0) {
      segments.push({
        kind: "active",
        realStartMs: turnStart,
        realEndMs: turnEnd,
        displayStartMs: displayCursor,
        displayEndMs: displayCursor + turnDuration,
      });
      displayCursor += turnDuration;
    }
    prevEndMs = Math.max(prevEndMs, turnEnd);
  }

  const displayTotalMs = Math.max(1, displayCursor);

  return {
    displayTotalMs,
    collapsedIdleMs,
    segments,
    breaks,
    realToDisplay: (realMs) => mapRealToDisplay(segments, realMs, displayTotalMs),
    displayToReal: (displayMs) => mapDisplayToReal(segments, displayMs),
  };
}

function mapRealToDisplay(
  segments: ReadonlyArray<TimingAxisSegment>,
  realMs: number,
  displayTotalMs: number,
): number {
  if (segments.length === 0) return 0;
  if (realMs <= segments[0]!.realStartMs) return segments[0]!.displayStartMs;
  const last = segments[segments.length - 1]!;
  if (realMs >= last.realEndMs) return last.displayEndMs;

  for (const segment of segments) {
    if (realMs < segment.realStartMs || realMs > segment.realEndMs) continue;
    const realSpan = Math.max(1, segment.realEndMs - segment.realStartMs);
    const displaySpan = segment.displayEndMs - segment.displayStartMs;
    const ratio = (realMs - segment.realStartMs) / realSpan;
    return segment.displayStartMs + ratio * displaySpan;
  }

  // Between segments (shouldn't happen with contiguous cover): snap to nearest.
  for (let index = 0; index < segments.length - 1; index++) {
    const left = segments[index]!;
    const right = segments[index + 1]!;
    if (realMs > left.realEndMs && realMs < right.realStartMs) {
      return left.displayEndMs;
    }
  }
  return Math.min(displayTotalMs, Math.max(0, last.displayEndMs));
}

function mapDisplayToReal(segments: ReadonlyArray<TimingAxisSegment>, displayMs: number): number {
  if (segments.length === 0) return 0;
  if (displayMs <= segments[0]!.displayStartMs) return segments[0]!.realStartMs;
  const last = segments[segments.length - 1]!;
  if (displayMs >= last.displayEndMs) return last.realEndMs;

  for (const segment of segments) {
    if (displayMs < segment.displayStartMs || displayMs > segment.displayEndMs) continue;
    const displaySpan = Math.max(1, segment.displayEndMs - segment.displayStartMs);
    const realSpan = segment.realEndMs - segment.realStartMs;
    const ratio = (displayMs - segment.displayStartMs) / displaySpan;
    return segment.realStartMs + ratio * realSpan;
  }
  return last.realEndMs;
}

/**
 * Builds a thread timing waterfall from existing run and turn-item timestamps.
 * No new server fields: queue wait is requested→started, work spans are timed items.
 */
export function deriveThreadTimingTrace(input: {
  readonly runs: ReadonlyArray<TimingRun>;
  readonly turnItems: ReadonlyArray<TimingTurnItem>;
  readonly messages?: ReadonlyArray<TimingMessage>;
  readonly nowMs: number;
}): ThreadTimingTrace | null {
  const runs = input.runs
    .filter((run) => run.status !== "rolled_back")
    .slice()
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  if (runs.length === 0) return null;

  const itemsByRun = new Map<TimingRun["id"], TimingTurnItem[]>();
  for (const item of input.turnItems) {
    if (item.runId === null) continue;
    const list = itemsByRun.get(item.runId);
    if (list) list.push(item);
    else itemsByRun.set(item.runId, [item]);
  }

  const turns: ThreadTimingTurn[] = [];
  for (const run of runs) {
    const requestedAtMs = toEpochMs(run.requestedAt);
    if (requestedAtMs === null) continue;
    const runItems = itemsByRun.get(run.id) ?? [];
    const workStartedAtMs =
      toEpochMs(run.workStartedAt) ?? toEpochMs(run.startedAt) ?? requestedAtMs;
    const startedAtMs = toEpochMs(run.startedAt);
    const endMs = runEndMs(run, runItems, input.nowMs);
    // No startedAt (still queued / canceled before start): queue through endMs.
    const queueEndMs = startedAtMs ?? endMs;
    const queueWaitMs = queueEndMs > requestedAtMs ? queueEndMs - requestedAtMs : 0;

    const spans: ThreadTimingSpan[] = [];
    if (queueWaitMs > 0) {
      spans.push({
        id: `${run.id}:queue`,
        kind: "queue",
        label: "Queued",
        startMs: requestedAtMs,
        endMs: queueEndMs,
        durationMs: queueWaitMs,
        status: "queued",
      });
    }

    for (const item of runItems) {
      const kind = spanKind(item.type);
      if (kind === null) continue;
      const startMs = toEpochMs(item.startedAt) ?? toEpochMs(item.updatedAt);
      if (startMs === null) continue;
      const endMsForItem = itemEndMs(item, input.nowMs) ?? startMs;
      if (endMsForItem < startMs) continue;
      spans.push({
        id: item.id,
        kind,
        label: spanLabel(item),
        startMs,
        endMs: endMsForItem,
        durationMs: endMsForItem - startMs,
        status: item.status,
      });
    }

    spans.sort(
      (left, right) =>
        left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id),
    );

    const waitMs = sumDurationByKind(spans, "wait");
    const durationMs = Math.max(0, endMs - requestedAtMs);
    const workMs = Math.max(0, durationMs - queueWaitMs - waitMs);

    turns.push({
      runId: run.id,
      ordinal: run.ordinal,
      label: turnLabel(run, input.messages),
      status: run.status,
      requestedAtMs,
      startMs: workStartedAtMs,
      endMs,
      durationMs,
      queueWaitMs,
      waitMs,
      workMs,
      spans,
    });
  }

  if (turns.length === 0) return null;

  const originMs = turns[0]!.requestedAtMs;
  const endMs = turns.reduce((latest, turn) => Math.max(latest, turn.endMs), originMs);
  const totalMs = Math.max(0, endMs - originMs);
  const queueWaitMs = turns.reduce((sum, turn) => sum + turn.queueWaitMs, 0);
  const waitMs = turns.reduce((sum, turn) => sum + turn.waitMs, 0);
  const workMs = turns.reduce((sum, turn) => sum + turn.workMs, 0);
  // Wall-clock busy time: overlapping parallel turns count once.
  const activeMs = unionIntervalMs(
    turns.map((turn) => ({ startMs: turn.requestedAtMs, endMs: turn.endMs })),
  );

  return {
    originMs,
    endMs,
    totalMs,
    activeMs,
    queueWaitMs,
    waitMs,
    workMs,
    turns,
  };
}

function unionIntervalMs(
  intervals: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>,
): number {
  const ordered = intervals
    .map((interval) => ({
      startMs: interval.startMs,
      endMs: Math.max(interval.endMs, interval.startMs),
    }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  if (ordered.length === 0) return 0;

  let total = 0;
  let coverStart = ordered[0]!.startMs;
  let coverEnd = ordered[0]!.endMs;
  for (let index = 1; index < ordered.length; index++) {
    const next = ordered[index]!;
    if (next.startMs > coverEnd) {
      total += coverEnd - coverStart;
      coverStart = next.startMs;
      coverEnd = next.endMs;
    } else {
      coverEnd = Math.max(coverEnd, next.endMs);
    }
  }
  return total + (coverEnd - coverStart);
}
