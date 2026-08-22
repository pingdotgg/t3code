import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

/** In-progress execute updates faster than this are dropped (#6556). */
export const GROK_TOOL_UPDATE_MIN_INTERVAL_MS = 250;
/** Keep the tail of cumulative terminal output so a progress bar still reads. */
export const GROK_TOOL_CONTENT_CHAR_LIMIT = 8_192;

export interface GrokToolUpdateGate {
  fingerprint: string;
  lastEmittedAt: number;
}

function grokToolDataSignature(data: unknown): string {
  if (typeof data === "string") {
    return `s${data.length}:${data.slice(-64)}`;
  }
  if (Array.isArray(data)) {
    const last = data.length === 0 ? "" : grokToolDataSignature(data[data.length - 1]);
    return `a${data.length}:${last}`;
  }
  if (data !== null && typeof data === "object") {
    return `{${Object.entries(data as Record<string, unknown>)
      .map(([key, value]) => `${key}:${grokToolDataSignature(value)}`)
      .join(",")}}`;
  }
  if (data === undefined) {
    return "u";
  }
  if (data === null) {
    return "n";
  }
  return String(data);
}

export function grokToolCallFingerprint(toolCall: AcpToolCallState): string {
  return [
    toolCall.toolCallId,
    toolCall.status ?? "",
    toolCall.title ?? "",
    toolCall.detail ?? "",
    grokToolDataSignature(toolCall.data),
  ].join("\u001f");
}

export function shouldEmitGrokToolUpdate(input: {
  readonly toolCall: AcpToolCallState;
  readonly previous: GrokToolUpdateGate | undefined;
  readonly nowMs: number;
}): boolean {
  const status = input.toolCall.status;
  if (status === "completed" || status === "failed") {
    return true;
  }
  if (
    input.previous !== undefined &&
    input.nowMs - input.previous.lastEmittedAt < GROK_TOOL_UPDATE_MIN_INTERVAL_MS
  ) {
    return false;
  }
  return input.previous?.fingerprint !== grokToolCallFingerprint(input.toolCall);
}

function truncateText(value: string): string {
  if (value.length <= GROK_TOOL_CONTENT_CHAR_LIMIT) {
    return value;
  }
  return value.slice(-GROK_TOOL_CONTENT_CHAR_LIMIT);
}

function boundUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateText(value);
  }
  if (Array.isArray(value)) {
    return value.map(boundUnknown);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      next[key] = boundUnknown(entry);
    }
    return next;
  }
  return value;
}

function boundDataToBudget(data: Record<string, unknown>): Record<string, unknown> {
  const perField = boundUnknown(data) as Record<string, unknown>;
  const serialized = JSON.stringify(perField) ?? "";
  if (serialized.length <= GROK_TOOL_CONTENT_CHAR_LIMIT + 256) {
    return perField;
  }
  return {
    truncated: true,
    tail: serialized.slice(-(GROK_TOOL_CONTENT_CHAR_LIMIT - 64)),
  };
}

/** Shrink cumulative Grok terminal payloads before they hit ingestion / NDJSON. */
export function boundGrokToolCallForEvent(input: {
  readonly toolCall: AcpToolCallState;
  readonly rawPayload: unknown;
}): { readonly toolCall: AcpToolCallState; readonly rawPayload: unknown } {
  const serialized = JSON.stringify(input.toolCall.data) ?? "";
  const rawSerialized = JSON.stringify(input.rawPayload) ?? "";
  if (
    serialized.length <= GROK_TOOL_CONTENT_CHAR_LIMIT &&
    rawSerialized.length <= GROK_TOOL_CONTENT_CHAR_LIMIT
  ) {
    return input;
  }
  return {
    toolCall: {
      ...input.toolCall,
      data: boundDataToBudget(input.toolCall.data),
      ...(typeof input.toolCall.detail === "string"
        ? { detail: truncateText(input.toolCall.detail) }
        : {}),
    },
    rawPayload: {
      truncated: true,
      toolCallId: input.toolCall.toolCallId,
      status: input.toolCall.status,
    },
  };
}
