/**
 * Wire compatibility for OpenCode 2 between the next-16233 generation
 * (`session.text.*` / `session.execution.*`) and the beta generation
 * (`session.next.*` steps). Runtime events are normalized to the older
 * canonical type names so the adapter switch can stay dual-compatible while
 * types come from the beta SDK.
 */

/** Canonical event type names used by the adapter switch. */
export type OpenCode2CanonicalEventType =
  | "session.created"
  | "session.input.promoted"
  | "session.input.admitted"
  | "session.agent.selected"
  | "session.model.selected"
  | "session.shell.started"
  | "session.shell.ended"
  | "shell.created"
  | "shell.exited"
  | "shell.deleted"
  | "session.text.started"
  | "session.text.delta"
  | "session.text.ended"
  | "session.reasoning.started"
  | "session.reasoning.delta"
  | "session.reasoning.ended"
  | "session.compaction.started"
  | "session.compaction.delta"
  | "session.compaction.ended"
  | "session.compaction.failed"
  | "session.tool.input.started"
  | "session.tool.input.delta"
  | "session.tool.input.ended"
  | "session.tool.called"
  | "session.tool.progress"
  | "session.tool.success"
  | "session.tool.failed"
  | "session.retry.scheduled"
  | "session.execution.started"
  | "session.execution.succeeded"
  | "session.execution.interrupted"
  | "session.execution.failed"
  | "session.idle"
  | "session.error"
  | "permission.v2.asked"
  | "permission.v2.replied"
  | "permission.asked"
  | "permission.replied"
  | "question.v2.asked"
  | "question.v2.replied"
  | "question.v2.rejected"
  | "question.asked"
  | "question.replied"
  | "question.rejected"
  | "form.created"
  | "form.replied"
  | "form.cancelled"
  | "server.connected"
  | "unknown";

const WIRE_TYPE_ALIASES: Readonly<Record<string, OpenCode2CanonicalEventType>> = {
  "session.next.agent.switched": "session.agent.selected",
  "session.next.model.switched": "session.model.selected",
  "session.next.prompt.admitted": "session.input.admitted",
  "session.next.prompted": "session.input.admitted",
  "session.next.shell.started": "session.shell.started",
  "session.next.shell.ended": "session.shell.ended",
  "session.next.step.started": "session.execution.started",
  // step.ended is not always a full-turn terminal (tool-calls continues).
  // Handlers inspect finish before settling.
  "session.next.step.ended": "session.execution.succeeded",
  "session.next.step.failed": "session.execution.failed",
  "session.next.text.started": "session.text.started",
  "session.next.text.delta": "session.text.delta",
  "session.next.text.ended": "session.text.ended",
  "session.next.reasoning.started": "session.reasoning.started",
  "session.next.reasoning.delta": "session.reasoning.delta",
  "session.next.reasoning.ended": "session.reasoning.ended",
  "session.next.compaction.started": "session.compaction.started",
  "session.next.compaction.delta": "session.compaction.delta",
  "session.next.compaction.ended": "session.compaction.ended",
  "session.next.tool.input.started": "session.tool.input.started",
  "session.next.tool.input.delta": "session.tool.input.delta",
  "session.next.tool.input.ended": "session.tool.input.ended",
  "session.next.tool.called": "session.tool.called",
  "session.next.tool.progress": "session.tool.progress",
  "session.next.tool.success": "session.tool.success",
  "session.next.tool.failed": "session.tool.failed",
  "session.next.retried": "session.retry.scheduled",
};

export function normalizeOpenCode2WireType(type: string): OpenCode2CanonicalEventType {
  if (type in WIRE_TYPE_ALIASES) return WIRE_TYPE_ALIASES[type]!;
  if (
    type.startsWith("session.") ||
    type.startsWith("shell.") ||
    type.startsWith("permission.") ||
    type.startsWith("question.") ||
    type.startsWith("form.") ||
    type === "server.connected"
  ) {
    return type as OpenCode2CanonicalEventType;
  }
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function openCode2WireData(event: { readonly data?: unknown }): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
}

export function openCode2WireCreatedMs(event: {
  readonly created?: number;
  readonly data?: unknown;
}): number | undefined {
  if (typeof event.created === "number" && Number.isFinite(event.created)) {
    return event.created;
  }
  const data = openCode2WireData(event);
  const timestamp = data.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

export function openCode2WireSessionID(event: { readonly data?: unknown }): string | undefined {
  const data = openCode2WireData(event);
  const value = data.sessionID ?? data.sessionId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function openCode2WireCallID(event: { readonly data?: unknown }): string | undefined {
  const data = openCode2WireData(event);
  const value = data.callID ?? data.callId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function openCode2WireToolName(event: { readonly data?: unknown }): string | undefined {
  const data = openCode2WireData(event);
  for (const key of ["name", "tool"] as const) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function openCode2WireTextDelta(event: { readonly data?: unknown }): string | undefined {
  const data = openCode2WireData(event);
  const value = data.delta ?? data.text;
  return typeof value === "string" ? value : undefined;
}

export function openCode2WireInputID(event: { readonly data?: unknown }): string | undefined {
  const data = openCode2WireData(event);
  const value = data.inputID ?? data.inputId ?? data.messageID ?? data.messageId ?? data.id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function openCode2WireErrorMessage(event: { readonly data?: unknown }): string {
  const data = openCode2WireData(event);
  const error = data.error;
  if (isRecord(error) && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) return error;
  return "OpenCode 2 provider error";
}

export function openCode2WireErrorCode(event: { readonly data?: unknown }): string | null {
  const data = openCode2WireData(event);
  const error = data.error;
  if (!isRecord(error)) return null;
  const type = error.type ?? error.name;
  return typeof type === "string" && type.length > 0 ? type : null;
}

/**
 * Whether a step.ended / execution.succeeded event should settle the full turn.
 * Beta multi-step loops end intermediate steps with tool-calls finishes.
 */
export function openCode2StepFinishSettlesTurn(finish: unknown): boolean {
  if (typeof finish !== "string" || finish.length === 0) {
    // Old execution.succeeded has no finish field; treat as terminal.
    return true;
  }
  const normalized = finish.trim().toLowerCase();
  if (
    normalized === "tool-calls" ||
    normalized === "tool_calls" ||
    normalized === "tool-call" ||
    normalized === "tool_call"
  ) {
    return false;
  }
  return true;
}

export function openCode2WireAgent(event: { readonly data?: unknown }): string | undefined {
  const data = openCode2WireData(event);
  const agent = data.agent ?? data.info;
  if (typeof agent === "string" && agent.length > 0) return agent;
  if (isRecord(agent) && typeof agent.agent === "string") return agent.agent;
  return undefined;
}

/**
 * Unwrap SDK responses that may be single- or double-enveloped depending on
 * generation (`{ data: T }` vs `{ data: { data: T } }`).
 */
export function unwrapOpenCode2Payload<A>(result: unknown): A | undefined {
  if (!isRecord(result)) return undefined;
  const outer = result.data;
  if (outer === undefined || outer === null) return undefined;
  // Prefer the double-wrapped body envelope `{ data: T }` used by /api responses.
  if (isRecord(outer) && "data" in outer) {
    const inner = outer.data;
    if (inner !== undefined && inner !== null) return inner as A;
    return undefined;
  }
  // Single-wrap bodies (arrays, concrete objects) are usable as-is. An empty
  // outer envelope is the silent failure mode this guard exists for.
  if (isRecord(outer) && Object.keys(outer).length === 0) return undefined;
  return outer as A;
}
