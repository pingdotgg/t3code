import { describe, expect, it } from "vite-plus/test";

const MAX_SUMMARY_CHARS = 160;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,96}$/;
const ORDINARY_TOOL_UPDATE_TYPES = new Set(["tool_call", "tool_call_update"]);

export type DevinSubagentEventClassification =
  | "stable child-agent stream"
  | "event stream without stable identity"
  | "no child-agent event support";

export interface DevinSanitizedSubagentObservation {
  readonly method: "session/update";
  readonly updateType: string;
  readonly toolCallId?: string;
  readonly summary?: string;
}

export const DEVIN_SUBAGENT_UNSUPPORTED_FIXTURE = {
  status: "unsupported",
  classification: "no child-agent event support",
  reason: "not-emitted-by-installed-devin-cli",
} as const;

interface DevinSubagentClassification {
  readonly classification: DevinSubagentEventClassification;
  readonly observations: ReadonlyArray<DevinSanitizedSubagentObservation>;
  readonly taskEvents: readonly [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const summary = value.trim();
  return summary.length > 0 ? summary.slice(0, MAX_SUMMARY_CHARS) : undefined;
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * Test-local capture for the negative-evidence path. It records only bounded,
 * non-sensitive fields and never turns an ordinary ACP tool update into a task.
 */
export function captureDevinSubagentObservation(
  event: unknown,
): DevinSanitizedSubagentObservation | undefined {
  if (!isRecord(event) || event.direction !== "incoming" || event.stage !== "decoded") {
    return undefined;
  }

  const messages = Array.isArray(event.payload) ? event.payload : [event.payload];
  const message = messages.find(isRecord);
  if (message?.tag !== "session/update") return undefined;

  const payload = isRecord(message.payload) ? message.payload : undefined;
  const update = payload && isRecord(payload.update) ? payload.update : undefined;
  if (update === undefined) return undefined;
  const updateType = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : undefined;
  if (updateType === undefined || updateType.length > 64) return undefined;

  const toolCallId = safeId(update.toolCallId);
  const summary = boundedSummary(update.title);
  return {
    method: "session/update",
    updateType,
    ...(toolCallId ? { toolCallId } : {}),
    ...(summary ? { summary } : {}),
  };
}

/**
 * Classify what the installed Devin ACP stream demonstrated. A future unknown
 * update is kept as an unclassified stream; it is never promoted to a stable
 * child-agent stream without observed identity, lifecycle, and parent linkage.
 */
export function classifyDevinSubagentEvents(
  events: ReadonlyArray<unknown>,
): DevinSubagentClassification {
  const observations = events.flatMap((event) => {
    const observation = captureDevinSubagentObservation(event);
    return observation ? [observation] : [];
  });

  const onlyOrdinaryToolUpdates =
    observations.length > 0 &&
    observations.every((observation) => ORDINARY_TOOL_UPDATE_TYPES.has(observation.updateType));

  return {
    classification:
      observations.length === 0 || onlyOrdinaryToolUpdates
        ? DEVIN_SUBAGENT_UNSUPPORTED_FIXTURE.classification
        : "event stream without stable identity",
    observations,
    taskEvents: [],
  };
}

const decodedUpdate = (update: Record<string, unknown>) => ({
  direction: "incoming",
  stage: "decoded",
  payload: [{ tag: "session/update", payload: { update } }],
});

describe("Devin ACP child-agent evidence", () => {
  it("records the explicit unsupported/no-stream result", () => {
    expect(DEVIN_SUBAGENT_UNSUPPORTED_FIXTURE).toEqual({
      status: "unsupported",
      classification: "no child-agent event support",
      reason: "not-emitted-by-installed-devin-cli",
    });
    expect(classifyDevinSubagentEvents([])).toMatchObject({
      classification: "no child-agent event support",
      taskEvents: [],
    });
  });

  it("does not synthesize a child agent from ordinary tool calls", () => {
    const result = classifyDevinSubagentEvents([
      decodedUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Delegate-like tool title",
      }),
      decodedUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "Delegate-like tool title",
      }),
    ]);

    expect(result.classification).toBe("no child-agent event support");
    expect(result.taskEvents).toEqual([]);
  });

  it("keeps duplicate ordinary updates out of task events", () => {
    const update = decodedUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-duplicate",
      title: "bounded tool update",
    });
    const result = classifyDevinSubagentEvents([update, update]);

    expect(result.observations).toHaveLength(2);
    expect(result.classification).toBe("no child-agent event support");
    expect(result.taskEvents).toEqual([]);
  });

  it("keeps out-of-order ordinary updates out of task events", () => {
    const result = classifyDevinSubagentEvents([
      decodedUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-out-of-order",
        status: "completed",
      }),
      decodedUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tool-out-of-order",
        status: "pending",
      }),
    ]);

    expect(result.classification).toBe("no child-agent event support");
    expect(result.taskEvents).toEqual([]);
  });

  it("does not treat an ordinary update without parent linkage as a child agent", () => {
    const result = classifyDevinSubagentEvents([
      decodedUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tool-no-parent",
        title: "ordinary tool",
      }),
    ]);

    expect(result.observations[0]).not.toHaveProperty("parentAgentId");
    expect(result.classification).toBe("no child-agent event support");
    expect(result.taskEvents).toEqual([]);
  });

  it("keeps a future unknown update as an event stream without stable identity", () => {
    const result = classifyDevinSubagentEvents([
      decodedUpdate({
        sessionUpdate: "future_update",
        title: "unrecognized update",
      }),
    ]);

    expect(result.classification).toBe("event stream without stable identity");
    expect(result.taskEvents).toEqual([]);
  });

  it("ignores malformed notifications without creating task events", () => {
    const result = classifyDevinSubagentEvents([
      undefined,
      { direction: "incoming", stage: "decoded", payload: [{ tag: "session/update" }] },
      decodedUpdate({ sessionUpdate: 42 }),
      decodedUpdate({ sessionUpdate: "tool_call", toolCallId: "bad id" }),
    ]);

    expect(result.observations).toEqual([{ method: "session/update", updateType: "tool_call" }]);
    expect(result.classification).toBe("no child-agent event support");
    expect(result.taskEvents).toEqual([]);
  });

  it("bounds sanitized summaries and omits raw payload fields", () => {
    const secretLikeText = "redacted-summary-" + "x".repeat(500);
    const result = classifyDevinSubagentEvents([
      decodedUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tool-bounded",
        title: secretLikeText,
        prompt: "must not be retained",
        credentials: "must not be retained",
      }),
    ]);

    expect(result.observations[0]).toEqual({
      method: "session/update",
      updateType: "tool_call",
      toolCallId: "tool-bounded",
      summary: secretLikeText.slice(0, MAX_SUMMARY_CHARS),
    });
    expect(JSON.stringify(result)).not.toContain("must not be retained");
    expect(JSON.stringify(result)).not.toContain("credentials");
  });
});
