/**
 * OpenCode 2 wire helpers. Maps runtime type strings onto the adapter switch's
 * internal names. The pinned 17823 wire uses short step/text names,
 * `session.inbox.*` admission, and first-class `session.execution.*`.
 */

/** Canonical event type names used by the adapter switch. */
export type OpenCode2CanonicalEventType =
  | "session.created"
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
  | "session.execution.failed"
  | "session.execution.interrupted"
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

/**
 * Lifecycle renames on the pinned 17823 wire. Internal switch cases keep
 * short canonical names.
 */
const WIRE_TYPE_ALIASES: Readonly<Record<string, OpenCode2CanonicalEventType>> = {
  "session.agent.switched": "session.agent.selected",
  "session.model.switched": "session.model.selected",
  "session.compaction.admitted": "session.compaction.started",
  "session.inbox.delivered": "session.input.admitted",
  "session.inbox.enqueued": "session.input.admitted",
  "session.input.promoted": "session.input.admitted",
  "session.prompt.admitted": "session.input.admitted",
  "session.prompted": "session.input.admitted",
  "session.step.started": "session.execution.started",
  // step.ended is not always a full-turn terminal (tool-calls continues).
  // Handlers inspect finish before settling.
  "session.step.ended": "session.execution.succeeded",
  "session.step.failed": "session.execution.failed",
  "session.retried": "session.retry.scheduled",
};

const PASSTHROUGH_TYPES = new Set<string>([
  "session.created",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.idle",
  "session.retry.scheduled",
  "session.input.admitted",
  "session.error",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.compaction.started",
  "session.compaction.delta",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.shell.started",
  "session.shell.ended",
  "server.connected",
  "shell.created",
  "shell.exited",
  "shell.deleted",
  "permission.v2.asked",
  "permission.v2.replied",
  "permission.asked",
  "permission.replied",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
  "question.asked",
  "question.replied",
  "question.rejected",
  // next-line question tool routes through the form API; without these the
  // events become "unknown" and the user never sees an Input card.
  "form.created",
  "form.replied",
  "form.cancelled",
]);

export function normalizeOpenCode2WireType(type: string): OpenCode2CanonicalEventType {
  if (type in WIRE_TYPE_ALIASES) return WIRE_TYPE_ALIASES[type]!;
  if (PASSTHROUGH_TYPES.has(type)) return type as OpenCode2CanonicalEventType;
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

export type OpenCode2WireSession = {
  readonly id: string;
  readonly agent?: string;
  readonly parentID?: string;
  readonly title: string;
  readonly model?: {
    readonly id: string;
    readonly providerID: string;
    readonly variant?: string;
  };
  readonly time: {
    readonly created?: number;
    readonly updated?: number;
  };
};

/** Accept nested session info and the flattened session-created event. */
export function openCode2WireSession(event: {
  readonly created?: number;
  readonly data?: unknown;
}): OpenCode2WireSession | undefined {
  const data = openCode2WireData(event);
  const nestedInfo = isRecord(data.info) ? data.info : {};
  const info = { ...data, ...nestedInfo };
  const id =
    (typeof info.id === "string" && info.id.length > 0 ? info.id : undefined) ??
    openCode2WireSessionID(event);
  if (id === undefined) return undefined;

  const parentID = info.parentID ?? info.parentId;
  const time = isRecord(info.time) ? info.time : {};
  const modelValue = info.model;
  const model =
    isRecord(modelValue) &&
    typeof modelValue.id === "string" &&
    typeof modelValue.providerID === "string"
      ? {
          id: modelValue.id,
          providerID: modelValue.providerID,
          ...(typeof modelValue.variant === "string" ? { variant: modelValue.variant } : {}),
        }
      : undefined;
  const created =
    typeof time.created === "number"
      ? time.created
      : typeof event.created === "number"
        ? event.created
        : undefined;
  const updated = typeof time.updated === "number" ? time.updated : created;

  return {
    id,
    ...(typeof info.agent === "string" && info.agent.length > 0 ? { agent: info.agent } : {}),
    ...(typeof parentID === "string" && parentID.length > 0 ? { parentID } : {}),
    title: typeof info.title === "string" && info.title.length > 0 ? info.title : id,
    ...(model === undefined ? {} : { model }),
    time: {
      ...(created === undefined ? {} : { created }),
      ...(updated === undefined ? {} : { updated }),
    },
  };
}

export function openCode2WireCallID(event: { readonly data?: unknown }): string | undefined {
  const data = openCode2WireData(event);
  // 17823 tool events key the call with `id` and put the tool name on `name`.
  // `callID` / `callId` remain accepted when present.
  const value = data.callID ?? data.callId ?? data.id;
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

/** Normalize tool result metadata across the 17823 wire shapes. */
export function openCode2WireToolMetadata(event: {
  readonly data?: unknown;
}): Record<string, unknown> | undefined {
  const data = openCode2WireData(event);
  const structured = isRecord(data.structured) ? data.structured : {};
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  const nestedMetadata = isRecord(metadata.metadata) ? metadata.metadata : {};
  const result = { ...metadata, ...nestedMetadata, ...structured };
  return Object.keys(result).length === 0 ? undefined : result;
}

export function openCode2WireTextDelta(event: { readonly data?: unknown }): string | undefined {
  const data = openCode2WireData(event);
  const value = data.delta ?? data.text;
  return typeof value === "string" ? value : undefined;
}

export function openCode2WireInputID(event: { readonly data?: unknown }): string | undefined {
  const data = openCode2WireData(event);
  const value =
    data.inputID ??
    data.inputId ??
    data.inboxID ??
    data.inboxId ??
    data.messageID ??
    data.messageId ??
    data.id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Admission payload. A later promotion has an input id but no payload. */
export function openCode2WireAdmittedInput(event: { readonly data?: unknown }): unknown {
  const data = openCode2WireData(event);
  return data.input ?? data.prompt ?? data.item;
}

export function openCode2WireErrorMessage(event: { readonly data?: unknown }): string {
  const data = openCode2WireData(event);
  const error = data.error;
  if (isRecord(error) && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  if (
    isRecord(error) &&
    isRecord(error.data) &&
    typeof error.data.message === "string" &&
    error.data.message.length > 0
  ) {
    return error.data.message;
  }
  if (typeof error === "string" && error.length > 0) return error;
  return "OpenCode 2 provider error";
}

export function openCode2WireErrorCode(event: { readonly data?: unknown }): string | null {
  const data = openCode2WireData(event);
  const error = data.error;
  if (!isRecord(error)) return null;
  const type = error.type ?? error.name ?? error._tag;
  return typeof type === "string" && type.length > 0 ? type : null;
}

/**
 * Whether a step.ended event should settle the full turn. Multi-step loops end
 * intermediate steps with tool-calls finishes.
 */
export function openCode2StepFinishSettlesTurn(finish: unknown): boolean {
  if (typeof finish !== "string" || finish.length === 0) {
    // Missing finish is treated as terminal (failed steps, synthetic settles).
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
 * Unwrap SDK responses that may be single- or double-enveloped
 * (`{ data: T }` vs `{ data: { data: T } }`).
 */
export function unwrapOpenCode2Payload<A>(result: unknown): A | undefined {
  if (result === undefined || result === null) return undefined;
  if (!isRecord(result)) return result as A;
  if (!("data" in result) || result.data === undefined) {
    return Object.keys(result).length === 0 ? undefined : (result as A);
  }
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
