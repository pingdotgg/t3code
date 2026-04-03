import { Cause, Exit } from "effect";

export type MetricAttributeValue = string;
export type MetricAttributes = Readonly<Record<string, MetricAttributeValue>>;
export type TraceAttributes = Readonly<Record<string, unknown>>;
export type ObservabilityOutcome = "success" | "failure" | "interrupt";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markSeen(value: object, seen: WeakSet<object>): boolean {
  if (seen.has(value)) {
    return true;
  }
  seen.add(value);
  return false;
}

function normalizeJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value ?? null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (Array.isArray(value)) {
    if (markSeen(value, seen)) {
      return "[Circular]";
    }
    return value.map((entry) => normalizeJsonValue(entry, seen));
  }
  if (value instanceof Map) {
    if (markSeen(value, seen)) {
      return "[Circular]";
    }
    return Object.fromEntries(
      Array.from(value.entries(), ([key, entryValue]) => [
        String(key),
        normalizeJsonValue(entryValue, seen),
      ]),
    );
  }
  if (value instanceof Set) {
    if (markSeen(value, seen)) {
      return "[Circular]";
    }
    return Array.from(value.values(), (entry) => normalizeJsonValue(entry, seen));
  }
  if (!isPlainObject(value)) {
    return String(value);
  }
  if (markSeen(value, seen)) {
    return "[Circular]";
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, normalizeJsonValue(entryValue, seen)]),
  );
}

export function compactTraceAttributes(
  attributes: Readonly<Record<string, unknown>>,
): TraceAttributes {
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, normalizeJsonValue(value)]),
  );
}

export function compactMetricAttributes(
  attributes: Readonly<Record<string, unknown>>,
): MetricAttributes {
  return Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) => {
      if (value === undefined || value === null) {
        return [];
      }
      if (typeof value === "string") {
        return [[key, value]];
      }
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return [[key, String(value)]];
      }
      return [];
    }),
  );
}

export function outcomeFromExit(exit: Exit.Exit<unknown, unknown>): ObservabilityOutcome {
  if (Exit.isSuccess(exit)) {
    return "success";
  }
  return Cause.hasInterruptsOnly(exit.cause) ? "interrupt" : "failure";
}

export function normalizeModelMetricLabel(model: string | null | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("gpt")) {
    return "gpt";
  }
  if (normalized.includes("claude")) {
    return "claude";
  }
  if (normalized.includes("gemini")) {
    return "gemini";
  }
  return "other";
}
