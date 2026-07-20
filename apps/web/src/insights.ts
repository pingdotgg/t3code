import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

export type InsightCategory =
  | "Thinking"
  | "Waiting"
  | "Read"
  | "Shell"
  | "Edit"
  | "Search"
  | "Other";

export interface InsightToolCall {
  readonly id: string;
  readonly name: string;
  readonly category: Exclude<InsightCategory, "Thinking" | "Waiting">;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly status: "running" | "completed" | "failed";
}

export interface InsightTurn {
  readonly turnId: TurnId;
  readonly provider: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly status: "running" | "completed" | "failed" | "aborted";
  readonly tools: ReadonlyArray<InsightToolCall>;
  readonly waitingMs: number;
  readonly thinkingMs: number;
  readonly durationMs: number;
}

export interface InsightAggregate {
  readonly turns: ReadonlyArray<InsightTurn>;
  readonly durationMs: number;
  readonly toolDurationMs: number;
  readonly waitingMs: number;
  readonly thinkingMs: number;
  readonly toolCallCount: number;
}

const INSIGHT_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "insights.turn.started",
  "insights.turn.completed",
  "insights.turn.aborted",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
  "user-input.requested",
  "user-input.resolved",
]);

/**
 * True for the lifecycle activities Insights derives timing from. These records
 * must be retained beyond the UI activity cap so long-thread totals stay
 * complete once older activities are evicted.
 */
export function isInsightActivity(activity: OrchestrationThreadActivity): boolean {
  return INSIGHT_ACTIVITY_KINDS.has(activity.kind);
}

interface MutableInterval {
  start: number;
  end?: number;
}

interface MutableTool {
  id: string;
  name: string;
  itemType: string;
  start: number;
  end?: number;
  status: InsightToolCall["status"];
}

interface MutableTurn {
  turnId: TurnId;
  provider: string;
  start?: number;
  end?: number;
  status: InsightTurn["status"];
  tools: Map<string, MutableTool>;
  waits: Map<string, MutableInterval>;
}

function recordPayload(activity: OrchestrationThreadActivity): Record<string, unknown> {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : {};
}

function timestamp(activity: OrchestrationThreadActivity): number | undefined {
  const value = Date.parse(activity.createdAt);
  return Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unionDuration(intervals: ReadonlyArray<readonly [number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals.toSorted((left, right) => left[0] - right[0]);
  let total = 0;
  let start = sorted[0]![0];
  let end = sorted[0]![1];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    if (current[0] <= end) {
      end = Math.max(end, current[1]);
    } else {
      total += Math.max(0, end - start);
      start = current[0];
      end = current[1];
    }
  }
  return total + Math.max(0, end - start);
}

function toolCategory(itemType: string, name: string): InsightToolCall["category"] {
  if (/^(read|view|glob|rg|grep|find|list)\b/i.test(name)) return "Read";
  switch (itemType) {
    case "command_execution":
      return "Shell";
    case "file_change":
      return "Edit";
    case "web_search":
      return "Search";
    default:
      return "Other";
  }
}

function getTurn(
  turns: Map<string, MutableTurn>,
  activity: OrchestrationThreadActivity,
  provider?: string,
): MutableTurn | undefined {
  if (activity.turnId === null) return undefined;
  const key = String(activity.turnId);
  const existing = turns.get(key);
  if (existing) {
    if (provider) existing.provider = provider;
    return existing;
  }
  const turn: MutableTurn = {
    turnId: activity.turnId,
    provider: provider ?? "Agent",
    status: "running",
    tools: new Map(),
    waits: new Map(),
  };
  turns.set(key, turn);
  return turn;
}

export function deriveInsights(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  nowMs: number,
): InsightAggregate {
  const turns = new Map<string, MutableTurn>();

  for (const activity of activities) {
    const at = timestamp(activity);
    if (at === undefined) continue;
    const payload = recordPayload(activity);
    const provider = stringValue(payload.provider);
    const turn = getTurn(turns, activity, provider);
    if (!turn) continue;

    switch (activity.kind) {
      case "insights.turn.started":
        turn.start = turn.start === undefined ? at : Math.min(turn.start, at);
        break;
      case "insights.turn.completed":
        turn.end = turn.end === undefined ? at : Math.max(turn.end, at);
        turn.status =
          payload.state === "failed"
            ? "failed"
            : payload.state === "interrupted" || payload.state === "cancelled"
              ? "aborted"
              : "completed";
        break;
      case "insights.turn.aborted":
        turn.end = turn.end === undefined ? at : Math.max(turn.end, at);
        turn.status = "aborted";
        break;
      case "tool.started":
      case "tool.updated":
      case "tool.completed": {
        const itemId = stringValue(payload.itemId);
        if (!itemId) break;
        const existing = turn.tools.get(itemId);
        const status =
          activity.kind === "tool.completed"
            ? payload.status === "failed"
              ? "failed"
              : "completed"
            : "running";
        const name = activity.summary.replace(/ started$/, "");
        if (existing) {
          existing.start = Math.min(existing.start, at);
          if (name !== "Tool" && name !== "Tool updated") existing.name = name;
          if (activity.kind === "tool.completed") existing.end = at;
          existing.status = status;
        } else {
          turn.tools.set(itemId, {
            id: itemId,
            name: activity.summary.replace(/ started$/, ""),
            itemType: stringValue(payload.itemType) ?? "dynamic_tool_call",
            start: at,
            ...(activity.kind === "tool.completed" ? { end: at } : {}),
            status,
          });
        }
        break;
      }
      case "approval.requested":
      case "user-input.requested": {
        const requestId = stringValue(payload.requestId);
        if (requestId) turn.waits.set(requestId, { start: at });
        break;
      }
      case "approval.resolved":
      case "user-input.resolved": {
        const requestId = stringValue(payload.requestId);
        const wait = requestId ? turn.waits.get(requestId) : undefined;
        if (wait) wait.end = at;
        break;
      }
    }
  }

  const finalized = [...turns.values()]
    .filter((turn): turn is MutableTurn & { start: number } => turn.start !== undefined)
    .map((turn): InsightTurn => {
      const endedAt = Math.max(turn.start, turn.end ?? nowMs);
      const tools = [...turn.tools.values()].map((tool): InsightToolCall => {
        const toolStart = Math.max(turn.start, tool.start);
        const toolEnd = Math.min(endedAt, Math.max(toolStart, tool.end ?? nowMs));
        return {
          id: tool.id,
          name: tool.name,
          category: toolCategory(tool.itemType, tool.name),
          startedAt: toolStart,
          endedAt: toolEnd,
          status: tool.status,
        };
      });
      const toolIntervals = tools.map((tool) => [tool.startedAt, tool.endedAt] as const);
      const waitingIntervals = [...turn.waits.values()].map(
        (wait) => [wait.start, Math.min(endedAt, Math.max(wait.start, wait.end ?? nowMs))] as const,
      );
      const waitingMs = unionDuration(waitingIntervals);
      const occupiedMs = unionDuration([...toolIntervals, ...waitingIntervals]);
      const durationMs = endedAt - turn.start;
      return {
        turnId: turn.turnId,
        provider: turn.provider,
        startedAt: turn.start,
        endedAt,
        status: turn.status,
        tools,
        waitingMs,
        thinkingMs: Math.max(0, durationMs - occupiedMs),
        durationMs,
      };
    })
    .toSorted((left, right) => right.startedAt - left.startedAt);

  let durationMs = 0;
  let toolDurationMs = 0;
  let waitingMs = 0;
  let thinkingMs = 0;
  let toolCallCount = 0;
  for (const turn of finalized) {
    durationMs += turn.durationMs;
    waitingMs += turn.waitingMs;
    thinkingMs += turn.thinkingMs;
    toolCallCount += turn.tools.length;
    for (const tool of turn.tools) toolDurationMs += tool.endedAt - tool.startedAt;
  }

  return { turns: finalized, durationMs, toolDurationMs, waitingMs, thinkingMs, toolCallCount };
}

export function formatInsightDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}
