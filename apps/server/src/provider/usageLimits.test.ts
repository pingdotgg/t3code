import { describe, expect, it } from "vite-plus/test";

import {
  applyUsageReading,
  normalizeClaudeRateLimitEvent,
  normalizeClaudeUsage,
  normalizeCodexUsage,
} from "./usageLimits.ts";

const UPDATED_AT = "2026-08-09T12:00:00.000Z";

describe("normalizeClaudeUsage", () => {
  it("reads session, weekly, and the model-scoped Fable bucket", () => {
    const usage = normalizeClaudeUsage(
      {
        five_hour: { utilization: 42, resets_at: "2026-08-09T14:15:00.000Z" },
        seven_day: { utilization: 61, resets_at: "2026-08-14T00:00:00.000Z" },
        limits: [
          {
            group: "weekly",
            percent: 12,
            resets_at: "2026-08-14T00:00:00.000Z",
            scope: { model: { display_name: "Claude Fable 5" } },
          },
        ],
      },
      UPDATED_AT,
    );

    expect(usage?.windows).toEqual([
      {
        id: "session",
        label: "Session",
        usedPercent: 42,
        resetsAt: "2026-08-09T14:15:00.000Z",
      },
      { id: "weekly", label: "Weekly", usedPercent: 61, resetsAt: "2026-08-14T00:00:00.000Z" },
      {
        id: "weekly-fable",
        label: "Fable",
        usedPercent: 12,
        resetsAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    expect(usage?.updatedAt).toBe(UPDATED_AT);
  });

  it("omits Fable when no weekly limit is scoped to it", () => {
    const usage = normalizeClaudeUsage(
      {
        five_hour: { utilization: 5 },
        limits: [{ group: "weekly", percent: 30, scope: { model: { display_name: "Opus 5" } } }],
      },
      UPDATED_AT,
    );

    expect(usage?.windows.map((window) => window.id)).toEqual(["session"]);
  });

  it("accepts epoch-second reset stamps", () => {
    const usage = normalizeClaudeUsage(
      { five_hour: { utilization: 1, resets_at: 1_786_000_000 } },
      UPDATED_AT,
    );

    expect(usage?.windows[0]?.resetsAt).toBe("2026-08-06T07:06:40.000Z");
  });

  it("returns null for malformed input", () => {
    expect(normalizeClaudeUsage(null, UPDATED_AT)).toBeNull();
    expect(normalizeClaudeUsage("nope", UPDATED_AT)).toBeNull();
    expect(normalizeClaudeUsage({}, UPDATED_AT)).toBeNull();
    expect(normalizeClaudeUsage({ five_hour: { utilization: "abc" } }, UPDATED_AT)).toBeNull();
  });

  it("treats a blank percentage as absent rather than zero", () => {
    // `Number("")` is 0, which would draw a confident empty meter for a
    // bucket the provider declined to report.
    expect(normalizeClaudeUsage({ five_hour: { utilization: "" } }, UPDATED_AT)).toBeNull();
    expect(normalizeClaudeUsage({ five_hour: { utilization: "  " } }, UPDATED_AT)).toBeNull();
  });

  it("falls through to the next reset alias when the first is unreadable", () => {
    // Same rule as the percentages: a present-but-malformed `resets_at`
    // must not mask a readable `resetsAt`.
    const usage = normalizeClaudeUsage(
      {
        five_hour: {
          utilization: 10,
          resets_at: "not-a-time",
          resetsAt: "2026-08-12T00:00:00.000Z",
        },
      },
      UPDATED_AT,
    );

    expect(usage?.windows[0]?.resetsAt).toBe("2026-08-12T00:00:00.000Z");
  });

  it("falls through to the next percent alias when the first is unreadable", () => {
    // A present-but-malformed `used_percentage` must not mask a readable
    // `utilization` on the same bucket.
    const usage = normalizeClaudeUsage(
      { five_hour: { used_percentage: "abc", utilization: 42 } },
      UPDATED_AT,
    );

    expect(usage?.windows[0]?.usedPercent).toBe(42);
  });
});

/**
 * The shape here is the real `SDKRateLimitEvent` the Claude Agent SDK emits
 * and `ClaudeAdapter` forwards verbatim — flat, with a single bucket under
 * `rate_limit_info`. An earlier version of this test invented a bucketed
 * envelope, which let a normalizer that could never read a real event pass.
 */
describe("normalizeClaudeRateLimitEvent", () => {
  it("maps a five_hour event onto the session window", () => {
    const usage = normalizeClaudeRateLimitEvent(
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 88,
          resetsAt: 1_786_000_000,
        },
        uuid: "1a5d5f5c-0000-4000-8000-000000000000",
        session_id: "session-1",
      },
      UPDATED_AT,
    );

    expect(usage?.windows).toEqual([
      {
        id: "session",
        label: "Session",
        usedPercent: 88,
        resetsAt: "2026-08-06T07:06:40.000Z",
      },
    ]);
  });

  it("maps seven_day onto the weekly window", () => {
    const usage = normalizeClaudeRateLimitEvent(
      { rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization: 30 } },
      UPDATED_AT,
    );

    expect(usage?.windows[0]?.id).toBe("weekly");
    expect(usage?.windows[0]?.resetsAt).toBeNull();
  });

  it("keeps model-scoped weekly buckets on their own windows", () => {
    for (const [rateLimitType, id] of [
      ["seven_day_opus", "weekly-opus"],
      ["seven_day_sonnet", "weekly-sonnet"],
    ] as const) {
      const usage = normalizeClaudeRateLimitEvent(
        { rate_limit_info: { status: "allowed", rateLimitType, utilization: 4 } },
        UPDATED_AT,
      );
      expect(usage?.windows[0]?.id).toBe(id);
    }
  });

  it("ignores overage, which is a spend state rather than a quota window", () => {
    expect(
      normalizeClaudeRateLimitEvent(
        { rate_limit_info: { status: "allowed", rateLimitType: "overage", utilization: 50 } },
        UPDATED_AT,
      ),
    ).toBeNull();
  });

  it("returns null when the event carries no usable bucket", () => {
    expect(normalizeClaudeRateLimitEvent(null, UPDATED_AT)).toBeNull();
    expect(normalizeClaudeRateLimitEvent({ type: "rate_limit_event" }, UPDATED_AT)).toBeNull();
    expect(
      normalizeClaudeRateLimitEvent({ rate_limit_info: { status: "allowed" } }, UPDATED_AT),
    ).toBeNull();
    expect(
      normalizeClaudeRateLimitEvent(
        { rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } },
        UPDATED_AT,
      ),
    ).toBeNull();
  });
});

describe("normalizeCodexUsage", () => {
  it("labels windows by duration, not by slot", () => {
    const usage = normalizeCodexUsage(
      {
        rateLimits: {
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_786_000_000 },
          secondary: { usedPercent: 70, windowDurationMins: 10_080, resetsAt: 1_786_500_000 },
        },
      },
      UPDATED_AT,
    );

    expect(usage?.windows.map((window) => [window.id, window.label])).toEqual([
      ["codex-primary", "Session"],
      ["codex-secondary", "Weekly"],
    ]);
  });

  it("keeps slot identity when the duration flips the label", () => {
    const usage = normalizeCodexUsage(
      { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 10_080 } } },
      UPDATED_AT,
    );

    expect(usage?.windows[0]).toEqual({
      id: "codex-primary",
      label: "Weekly",
      usedPercent: 20,
      resetsAt: null,
    });
  });

  it("falls back to slot order when the duration is missing", () => {
    const usage = normalizeCodexUsage(
      { rateLimits: { primary: { usedPercent: 1 }, secondary: { usedPercent: 2 } } },
      UPDATED_AT,
    );

    expect(usage?.windows.map((window) => window.label)).toEqual(["Session", "Weekly"]);
  });

  it("returns null for malformed input", () => {
    expect(normalizeCodexUsage(null, UPDATED_AT)).toBeNull();
    expect(normalizeCodexUsage({ rateLimits: {} }, UPDATED_AT)).toBeNull();
    expect(normalizeCodexUsage({ rateLimits: { primary: {} } }, UPDATED_AT)).toBeNull();
  });
});

describe("applyUsageReading", () => {
  const window = (id: string, usedPercent: number) => ({
    id,
    label: id,
    usedPercent,
    resetsAt: null,
  });
  const stored = {
    windows: [window("session", 40), window("weekly", 60), window("weekly-fable", 10)],
    updatedAt: "2026-08-09T11:00:00.000Z",
  };

  it("keeps unmentioned windows when a partial reading lands", () => {
    // The regression this guards: a Claude turn event describes one bucket,
    // and Codex's rolling update is explicitly sparse. Treating either as a
    // full reading blanks every other meter.
    const merged = applyUsageReading(
      stored,
      { windows: [window("session", 55)], updatedAt: "2026-08-09T12:00:00.000Z" },
      "partial",
    );

    expect(merged.windows).toEqual([
      window("session", 55),
      window("weekly", 60),
      window("weekly-fable", 10),
    ]);
    expect(merged.updatedAt).toBe("2026-08-09T12:00:00.000Z");
  });

  it("appends a genuinely new window without reordering the existing ones", () => {
    const merged = applyUsageReading(
      stored,
      { windows: [window("weekly-opus", 3)], updatedAt: "2026-08-09T12:00:00.000Z" },
      "partial",
    );

    expect(merged.windows.map((entry) => entry.id)).toEqual([
      "session",
      "weekly",
      "weekly-fable",
      "weekly-opus",
    ]);
  });

  it("lets a full reading retire a window the account no longer has", () => {
    const merged = applyUsageReading(
      stored,
      { windows: [window("session", 55)], updatedAt: "2026-08-09T12:00:00.000Z" },
      "full",
    );

    expect(merged.windows.map((entry) => entry.id)).toEqual(["session"]);
  });

  it("adopts any reading when nothing is stored yet", () => {
    const incoming = { windows: [window("session", 1)], updatedAt: "2026-08-09T12:00:00.000Z" };
    expect(applyUsageReading(undefined, incoming, "partial")).toBe(incoming);
  });

  it("never lets a stale reading rewind the meters", () => {
    const stale = { windows: [window("session", 5)], updatedAt: "2026-08-09T10:00:00.000Z" };
    expect(applyUsageReading(stored, stale, "partial")).toBe(stored);
    expect(applyUsageReading(stored, stale, "full")).toBe(stored);
  });

  it("treats an unparseable stamp as the oldest possible reading", () => {
    const malformed = { windows: [window("session", 5)], updatedAt: "not-a-date" };
    expect(applyUsageReading(stored, malformed, "full")).toBe(stored);
  });
});
