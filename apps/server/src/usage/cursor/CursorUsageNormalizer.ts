/**
 * Pure mapping from Cursor's Admin API event shape to the normalized,
 * persisted `CursorUsageEvent`.
 *
 * @module CursorUsageNormalizer
 */
import type { CursorUsageEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { CursorAdminUsageEvent } from "./CursorUsageSchemas.ts";

function isoFromMs(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

/** Deterministic, dependency-free FNV-1a hash for a synthetic event id. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const DIGITS_ONLY = /^\d+$/;

function resolveTimestampMs(timestamp: number | string | undefined): number | null {
  if (timestamp === undefined) return null;
  if (typeof timestamp === "number") {
    // Treat anything shaped like epoch seconds (10 digits) as such rather
    // than as year-275760+.
    return timestamp < 1e12 ? timestamp * 1000 : timestamp;
  }
  // The dashboard session connector reports epoch milliseconds as a
  // *string* (confirmed against a live response); the Admin API is assumed
  // to report either epoch millis or an ISO string.
  if (DIGITS_ONLY.test(timestamp)) {
    const numeric = Number(timestamp);
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Cursor's dashboard connector reports `kind` as an enum-shaped constant
 * (e.g. `"USAGE_EVENT_KIND_INCLUDED_IN_PRO"`); the Admin API's kind strings
 * are not pinned to a spec. Matching on "INCLUDED" covers both rather than
 * trying to enumerate every non-included variant.
 */
function resolveUsageType(kind: string | undefined): "included" | "onDemand" {
  if (kind === undefined) return "included";
  return kind.toUpperCase().includes("INCLUDED") ? "included" : "onDemand";
}

/**
 * Derives a stable event identity when the API omits one.
 *
 * Built from provider + timestamp + model + token counts + cost rather than
 * array position, so the same page fetched twice (overlapping sync windows)
 * yields the same id and de-duplicates on insert.
 */
function stableEventId(event: CursorAdminUsageEvent, timestampMs: number): string {
  const key = [
    "cursor",
    timestampMs,
    event.model ?? "",
    event.inputTokens ?? "",
    event.outputTokens ?? "",
    event.cacheWriteTokens ?? "",
    event.cacheReadTokens ?? "",
    event.requestsCosts ?? "",
    event.totalCents ?? "",
    event.conversationId ?? "",
  ].join("|");
  return `cursor-synth-${fnv1a(key)}`;
}

function toDayUtc(timestampMs: number): string {
  return isoFromMs(timestampMs).slice(0, 10);
}

function sumOptional(...values: ReadonlyArray<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : present.reduce((total, value) => total + value, 0);
}

/**
 * Normalizes one Admin API event, or returns `null` for an event with no
 * usable timestamp (counted as malformed by the caller, not silently
 * dropped).
 */
export function normalizeCursorAdminEvent(event: CursorAdminUsageEvent): CursorUsageEvent | null {
  const timestampMs = resolveTimestampMs(event.timestamp);
  if (timestampMs === null) return null;

  const id =
    event.id !== undefined && event.id.length > 0 ? event.id : stableEventId(event, timestampMs);

  return {
    id: id as CursorUsageEvent["id"],
    occurredAt: isoFromMs(timestampMs),
    day: toDayUtc(timestampMs) as CursorUsageEvent["day"],
    model: event.model && event.model.length > 0 ? event.model : "unknown",
    usageType: resolveUsageType(event.kind),
    ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
    ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
    ...(event.cacheWriteTokens !== undefined ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
    ...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
    ...(() => {
      const totalTokens = sumOptional(
        event.inputTokens,
        event.outputTokens,
        event.cacheWriteTokens,
        event.cacheReadTokens,
      );
      return totalTokens === undefined ? {} : { totalTokens };
    })(),
    ...(event.requestsCosts !== undefined ? { rawCostCents: event.requestsCosts } : {}),
    ...(event.totalCents !== undefined ? { chargedCents: event.totalCents } : {}),
  };
}
