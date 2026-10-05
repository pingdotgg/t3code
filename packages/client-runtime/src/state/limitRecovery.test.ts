import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { resolveScheduledLimitResume } from "./limitRecovery.ts";

const runId = RunId.make("limited-run");
function localDate(day: number, hour: number) {
  return DateTime.toDateUtc(
    DateTime.makeZonedUnsafe(
      { year: 2026, month: 10, day, hour },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    ),
  );
}

const now = localDate(4, 1);
const resetAt = localDate(4, 4).toISOString();
const thread = {
  archivedAt: null,
  settledOverride: null,
  snoozedUntil: null,
  runtime: {
    status: "failed" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: "Usage limit reached",
    lastErrorClass: "usage_limit" as const,
    usageLimitResetAt: resetAt,
    updatedAt: now.toISOString(),
  },
  latestRun: {
    runId,
    status: "failed" as const,
    requestedAt: now.toISOString(),
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    assistantMessageId: null,
  },
  limitRecovery: { runId, resetAt, autoResume: true },
};

describe("scheduled usage-limit resume", () => {
  it("shows the local time for today's reset and the date for another day", () => {
    const time = DateTime.toDateUtc(DateTime.makeUnsafe(resetAt)).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(resolveScheduledLimitResume(thread, now)?.label).toBe(time);
    const date = localDate(4, 4).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect(resolveScheduledLimitResume(thread, localDate(3, 1))?.label).toBe(`${date}, ${time}`);
    expect(resolveScheduledLimitResume(thread, now)?.description).toContain(
      "Auto-resume scheduled",
    );
  });
  it("clears the promise after cancellation or when recovery belongs to another stop", () => {
    expect(
      resolveScheduledLimitResume(
        { ...thread, limitRecovery: { ...thread.limitRecovery, autoResume: false } },
        now,
      ),
    ).toBeNull();
    expect(
      resolveScheduledLimitResume(
        { ...thread, limitRecovery: { ...thread.limitRecovery, runId: RunId.make("old-run") } },
        now,
      ),
    ).toBeNull();
    expect(
      resolveScheduledLimitResume(
        {
          ...thread,
          limitRecovery: {
            ...thread.limitRecovery,
            resetAt: localDate(5, 4).toISOString(),
          },
        },
        now,
      ),
    ).toBeNull();
  });
  it("does not show a scheduled resume once work starts or the thread is settled or archived", () => {
    expect(
      resolveScheduledLimitResume(
        { ...thread, runtime: { ...thread.runtime, status: "running" } },
        now,
      ),
    ).toBeNull();
    expect(resolveScheduledLimitResume({ ...thread, settledOverride: "settled" }, now)).toBeNull();
    expect(
      resolveScheduledLimitResume({ ...thread, archivedAt: now.toISOString() }, now),
    ).toBeNull();
  });
  it("shows a later snooze time because recovery cannot start before the thread wakes", () => {
    const snoozedUntil = localDate(5, 4).toISOString();
    const later = resolveScheduledLimitResume({ ...thread, snoozedUntil }, now);
    const nextDay = resolveScheduledLimitResume(
      {
        ...thread,
        runtime: { ...thread.runtime, usageLimitResetAt: snoozedUntil },
        limitRecovery: { ...thread.limitRecovery, resetAt: snoozedUntil },
      },
      now,
    );
    expect(later?.label).toBe(nextDay?.label);
    expect(later?.label).toContain(
      localDate(5, 4).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(
      resolveScheduledLimitResume({ ...thread, snoozedUntil: now.toISOString() }, now)?.label,
    ).toBe(resolveScheduledLimitResume(thread, now)?.label);
  });
  it("does not promise recovery when it is missing, invalid, or belongs to a different failure", () => {
    expect(resolveScheduledLimitResume({ ...thread, limitRecovery: null }, now)).toBeNull();
    expect(
      resolveScheduledLimitResume(
        { ...thread, runtime: { ...thread.runtime, lastErrorClass: "provider_error" } },
        now,
      ),
    ).toBeNull();
    expect(
      resolveScheduledLimitResume(
        {
          ...thread,
          runtime: { ...thread.runtime, usageLimitResetAt: "invalid" },
          limitRecovery: { ...thread.limitRecovery, resetAt: "invalid" },
        },
        now,
      ),
    ).toBeNull();
  });
  it("keeps the scheduled label while waiting for a restart after the reset time", () => {
    expect(resolveScheduledLimitResume(thread, localDate(4, 5))).not.toBeNull();
  });
});
