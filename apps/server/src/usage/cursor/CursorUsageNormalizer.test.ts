import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { normalizeCursorAdminEvent } from "./CursorUsageNormalizer.ts";
import type { CursorAdminUsageEvent } from "./CursorUsageSchemas.ts";

function rawEvent(overrides: Partial<CursorAdminUsageEvent> = {}): CursorAdminUsageEvent {
  return {
    id: "evt_1",
    timestamp: Date.parse("2026-08-07T12:00:00.000Z"),
    model: "cursor-grok-4.5",
    kind: "included",
    inputTokens: 100,
    outputTokens: 50,
    cacheWriteTokens: 10,
    cacheReadTokens: 20,
    requestsCosts: 250,
    totalCents: 0,
    ...overrides,
  };
}

describe("normalizeCursorAdminEvent", () => {
  it("maps a well-formed event to the normalized shape", () => {
    const normalized = normalizeCursorAdminEvent(rawEvent());
    expect(normalized).not.toBeNull();
    expect(normalized?.id).toBe("evt_1");
    expect(normalized?.occurredAt).toBe("2026-08-07T12:00:00.000Z");
    expect(normalized?.day).toBe("2026-08-07");
    expect(normalized?.model).toBe("cursor-grok-4.5");
    expect(normalized?.usageType).toBe("included");
    expect(normalized?.totalTokens).toBe(180);
    expect(normalized?.rawCostCents).toBe(250);
    expect(normalized?.chargedCents).toBe(0);
  });

  it("returns null for a missing timestamp instead of guessing one", () => {
    expect(normalizeCursorAdminEvent(rawEvent({ timestamp: undefined }))).toBeNull();
  });

  it("returns null for an unparsable string timestamp", () => {
    expect(normalizeCursorAdminEvent(rawEvent({ timestamp: "not-a-date" }))).toBeNull();
  });

  it("treats epoch-seconds-shaped numbers as seconds, not milliseconds", () => {
    const normalized = normalizeCursorAdminEvent(rawEvent({ timestamp: 1_754_568_000 }));
    expect(normalized?.occurredAt).toBe(
      DateTime.formatIso(DateTime.makeUnsafe(1_754_568_000 * 1000)),
    );
  });

  it("classifies on-demand usage from the kind field", () => {
    const normalized = normalizeCursorAdminEvent(rawEvent({ kind: "usage-based" }));
    expect(normalized?.usageType).toBe("onDemand");
  });

  it("parses a stringified epoch-millisecond timestamp (session connector's real shape)", () => {
    const normalized = normalizeCursorAdminEvent(rawEvent({ timestamp: "1786315407799" }));
    expect(normalized?.occurredAt).toBe(DateTime.formatIso(DateTime.makeUnsafe(1_786_315_407_799)));
  });

  it("classifies the session connector's real included-usage kind constant", () => {
    const normalized = normalizeCursorAdminEvent(
      rawEvent({ kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO" }),
    );
    expect(normalized?.usageType).toBe("included");
  });

  it("derives a stable synthetic id when the API omits one", () => {
    const first = normalizeCursorAdminEvent(rawEvent({ id: undefined }));
    const second = normalizeCursorAdminEvent(rawEvent({ id: undefined }));
    expect(first?.id).toBe(second?.id);
    expect(first?.id).toMatch(/^cursor-synth-/);
  });

  it("derives different synthetic ids for genuinely different events", () => {
    const first = normalizeCursorAdminEvent(rawEvent({ id: undefined, model: "model-a" }));
    const second = normalizeCursorAdminEvent(rawEvent({ id: undefined, model: "model-b" }));
    expect(first?.id).not.toBe(second?.id);
  });

  it("omits token/cost fields the API did not report rather than defaulting to zero", () => {
    const normalized = normalizeCursorAdminEvent(
      rawEvent({
        inputTokens: undefined,
        outputTokens: undefined,
        cacheWriteTokens: undefined,
        cacheReadTokens: undefined,
        requestsCosts: undefined,
        totalCents: undefined,
      }),
    );
    expect(normalized?.inputTokens).toBeUndefined();
    expect(normalized?.totalTokens).toBeUndefined();
    expect(normalized?.rawCostCents).toBeUndefined();
  });

  it("falls back to 'unknown' for a missing model rather than dropping the event", () => {
    const normalized = normalizeCursorAdminEvent(rawEvent({ model: undefined }));
    expect(normalized?.model).toBe("unknown");
  });
});
