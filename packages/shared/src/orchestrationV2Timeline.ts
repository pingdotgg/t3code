import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
} from "@t3tools/contracts";

type TimelineRun = Pick<OrchestrationV2Run, "id" | "status">;
type TimelineRunAttempt = Pick<OrchestrationV2RunAttempt, "runId" | "rootNodeId" | "status">;
type TimelineTurnItem = Pick<OrchestrationV2TurnItem, "type" | "runId" | "nodeId"> & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
};

/** Selects readable messages without giving historical speech user-message execution semantics. */
export function isOrchestrationV2MessageHistoryItem(
  item: Pick<OrchestrationV2TurnItem, "type"> & {
    readonly status?: OrchestrationV2TurnItem["status"];
    readonly captureState?: string;
    readonly content?: { readonly type: string };
  },
): boolean {
  if (item.type === "realtime_voice") {
    return (
      item.status === "completed" &&
      item.captureState === "canonical_completed" &&
      item.content?.type === "transcriptSegment"
    );
  }
  return (
    item.type === "user_message" ||
    item.type === "assistant_message" ||
    item.type === "proposed_plan"
  );
}

type RealtimeVoiceProvenance = Pick<
  Extract<OrchestrationV2TurnItem, { readonly type: "realtime_voice" }>,
  "captureState" | "historyCoverage" | "sourceOrder" | "timestampProvenance"
>;

/**
 * Capture labels shared by web and mobile voice rows. Text is always the provider's streamed
 * transcript, so no state claims corrected or heard words.
 */
export function describeRealtimeVoiceCapture(item: RealtimeVoiceProvenance): {
  readonly status: string;
  readonly timeLabel: "Observed" | "Recovered";
  readonly detail: string;
} {
  const capture =
    item.captureState === "canonical_completed"
      ? "The provider committed this streamed transcript. It may differ from what was heard."
      : `The voice session ${item.captureState === "interrupted" ? "failed" : "ended"} before the provider committed this segment. Text is what streamed before it stopped.`;
  const source =
    item.historyCoverage === "provider_history" ? " Recovered from provider history." : "";
  const order =
    item.sourceOrder === "provider_anchored"
      ? " Placed after the coding turn that preceded it in provider history."
      : " Shown where T3 received it; order against coding turns is not reconciled.";
  return {
    status:
      item.captureState === "canonical_completed"
        ? "Provider completed"
        : item.captureState === "interrupted"
          ? "Interrupted · partial"
          : "Incomplete · partial",
    timeLabel: item.timestampProvenance === "recovered" ? "Recovered" : "Observed",
    detail: `${capture}${source}${order}`,
  };
}

function isOrchestrationV2SupersededInterrupt(input: {
  readonly item: TimelineTurnItem;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): boolean {
  const { item } = input;
  if (item.type !== "run_interrupt_result" || item.runId === null || item.nodeId === null) {
    return false;
  }

  const isSuperseded = input.attempts.some(
    (attempt) =>
      attempt.runId === item.runId &&
      attempt.rootNodeId === item.nodeId &&
      attempt.status === "superseded",
  );
  if (!isSuperseded) {
    return false;
  }

  // Show paired stop-then-steer results; hide legacy plain-steer results without matching requests.
  const hasMatchingRequest = input.items.some(
    (candidate) => candidate.type === "run_interrupt_request" && candidate.runId === item.runId,
  );
  return !hasMatchingRequest;
}

export function isOrchestrationV2TurnItemVisible(input: {
  readonly item: TimelineTurnItem;
  readonly runs: ReadonlyArray<TimelineRun>;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): boolean {
  const { item } = input;
  if (
    item.runId !== null &&
    input.runs.some((run) => run.id === item.runId && run.status === "rolled_back")
  ) {
    return false;
  }

  // A steer can return to the queue before delivery. Keep its retained item out
  // of conversation history until its run starts; cancelled queued inputs stay hidden.
  if (
    item.type === "user_message" &&
    item.inputIntent === "queued_turn" &&
    item.runId !== null &&
    input.runs.some(
      (run) => run.id === item.runId && (run.status === "queued" || run.status === "cancelled"),
    )
  ) {
    return false;
  }

  return !isOrchestrationV2SupersededInterrupt({
    item,
    attempts: input.attempts,
    items: input.items,
  });
}

export function createOrchestrationV2TurnItemVisibility(input: {
  readonly runs: ReadonlyArray<TimelineRun>;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): (item: TimelineTurnItem) => boolean {
  const statuses = new Map<TimelineRun["id"], TimelineRun["status"]>();
  for (const run of input.runs) {
    if (run.status === "rolled_back" || run.status === "cancelled" || run.status === "queued")
      statuses.set(run.id, run.status);
    else statuses.delete(run.id);
  }
  const supersededRoots = new Map<
    TimelineRunAttempt["runId"],
    Set<TimelineRunAttempt["rootNodeId"]>
  >();
  for (const attempt of input.attempts) {
    if (attempt.status !== "superseded") continue;
    let roots = supersededRoots.get(attempt.runId);
    if (roots === undefined) supersededRoots.set(attempt.runId, (roots = new Set()));
    roots.add(attempt.rootNodeId);
  }
  if (statuses.size === 0 && supersededRoots.size === 0) return () => true;
  const interruptRuns = new Set<TimelineTurnItem["runId"]>();
  if (supersededRoots.size > 0) {
    for (const item of input.items) {
      if (item.type === "run_interrupt_request") interruptRuns.add(item.runId);
    }
  }
  return (item) => {
    const status = item.runId === null ? undefined : statuses.get(item.runId);
    if (status === "rolled_back") return false;
    if (
      (status === "queued" || status === "cancelled") &&
      item.type === "user_message" &&
      item.inputIntent === "queued_turn"
    )
      return false;
    return !(
      item.type === "run_interrupt_result" &&
      item.runId !== null &&
      item.nodeId !== null &&
      supersededRoots.get(item.runId)?.has(item.nodeId) === true &&
      !interruptRuns.has(item.runId)
    );
  };
}

type RealtimeVoiceItem = Extract<OrchestrationV2TurnItem, { readonly type: "realtime_voice" }>;

/** Spoken lines the clients render; markers, promotion records, and unfinished text are not lines. */
export function isDisplayedRealtimeVoiceLine(item: RealtimeVoiceItem): boolean {
  return (
    (item.status === "completed" || item.status === "interrupted") &&
    item.content.type === "transcriptSegment" &&
    item.content.text.trim().length > 0
  );
}

/** One realtime voice call, shown as a single divider above its first line. */
export interface RealtimeVoiceCall {
  readonly startedAt: string;
  /** Null while the call is live or when it never recorded an end. */
  readonly durationMs: number | null;
  readonly failed: boolean;
  /** Provider history warnings folded into this call; null when history is complete. */
  readonly historyWarning: string | null;
}

export interface RealtimeVoiceCallLayout<Row> {
  /** The divider's host: the call's started marker, or its first line when the marker is missing. */
  readonly callByHostRow: ReadonlyMap<Row, RealtimeVoiceCall>;
  /** Start/end markers and history warnings now carried by a divider; clients skip these rows. */
  readonly foldedRows: ReadonlySet<Row>;
}

/**
 * Groups voice items into calls for web and mobile by their start and end markers in order.
 * Calls without spoken lines render nothing.
 * A "Voice history incomplete" warning names no realtime session, so it joins the latest call
 * before it; with no such call it stays a standalone row.
 */
export function layoutRealtimeVoiceCalls<Row extends { readonly item: OrchestrationV2TurnItem }>(
  rows: ReadonlyArray<Row>,
): RealtimeVoiceCallLayout<Row> {
  interface Draft {
    host: Row | undefined;
    markers: Row[];
    warnings: Array<{ readonly row: Row; readonly message: string }>;
    startedAt: DateTime.DateTime | undefined;
    endedAt: number | undefined;
    failed: boolean;
    hasLines: boolean;
  }
  const calls: Draft[] = [];
  // Codex reuses one realtime session id for every call in a thread, so markers split calls.
  const openCallBySession = new Map<string, Draft>();
  let latest: Draft | undefined;
  for (const row of rows) {
    const item = row.item;
    if (item.type === "error" && item.failure.code === "voice_history_incomplete") {
      latest?.warnings.push({ row, message: item.failure.message });
      continue;
    }
    if (item.type !== "realtime_voice" || item.content.type === "bemItemPromoted") continue;
    const key = `${item.nativeThreadId}\u0000${item.realtimeSessionId}`;
    let draft = openCallBySession.get(key);
    // A start always opens a call; after an end, recovered lines without a start open one too.
    if (
      draft === undefined ||
      item.content.type === "realtimeSessionStarted" ||
      draft.endedAt !== undefined
    ) {
      draft = {
        host: undefined,
        markers: [],
        warnings: [],
        startedAt: undefined,
        endedAt: undefined,
        failed: false,
        hasLines: false,
      };
      calls.push(draft);
      openCallBySession.set(key, draft);
    }
    latest = draft;
    const at = item.startedAt ?? item.updatedAt;
    if (item.content.type === "realtimeSessionStarted") {
      draft.markers.push(row);
      draft.host ??= row;
      draft.startedAt = at;
    } else if (item.content.type === "realtimeSessionClosed") {
      draft.markers.push(row);
      draft.endedAt = DateTime.toEpochMillis(item.completedAt ?? item.updatedAt);
      draft.failed = item.content.outcome === "failed";
    } else if (isDisplayedRealtimeVoiceLine(item)) {
      draft.hasLines = true;
      draft.host ??= row;
      draft.startedAt ??= at;
    }
  }
  const callByHostRow = new Map<Row, RealtimeVoiceCall>();
  const foldedRows = new Set<Row>();
  for (const draft of calls) {
    for (const marker of draft.markers)
      if (marker !== draft.host || !draft.hasLines) foldedRows.add(marker);
    if (!draft.hasLines || draft.host === undefined || draft.startedAt === undefined) continue;
    for (const warning of draft.warnings) foldedRows.add(warning.row);
    callByHostRow.set(draft.host, {
      startedAt: DateTime.formatIso(draft.startedAt),
      durationMs:
        draft.endedAt === undefined
          ? null
          : Math.max(0, draft.endedAt - DateTime.toEpochMillis(draft.startedAt)),
      failed: draft.failed,
      historyWarning:
        draft.warnings.length === 0
          ? null
          : draft.warnings.map((warning) => warning.message).join(" "),
    });
  }
  return { callByHostRow, foldedRows };
}

export function realtimeVoiceCallsEqual(
  left: RealtimeVoiceCall | undefined,
  right: RealtimeVoiceCall | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.startedAt === right.startedAt &&
      left.durationMs === right.durationMs &&
      left.failed === right.failed &&
      left.historyWarning === right.historyWarning)
  );
}
