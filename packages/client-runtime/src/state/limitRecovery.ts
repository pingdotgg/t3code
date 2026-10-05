import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { EnvironmentThreadShell } from "./models.ts";

/** Only a persisted recovery for the current usage-limit stop promises a restart. */
export function resolveScheduledLimitResume(
  thread: Pick<
    EnvironmentThreadShell,
    "runtime" | "latestRun" | "limitRecovery" | "archivedAt" | "settledOverride" | "snoozedUntil"
  >,
  now = DateTime.toDateUtc(DateTime.nowUnsafe()),
) {
  const recovery = thread.limitRecovery;
  if (
    thread.runtime?.status !== "failed" ||
    thread.runtime.lastErrorClass !== "usage_limit" ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    !recovery?.autoResume ||
    recovery.runId !== thread.latestRun?.runId ||
    recovery.resetAt !== thread.runtime.usageLimitResetAt
  )
    return null;
  const resetAt = DateTime.make(recovery.resetAt);
  if (Option.isNone(resetAt)) return null;
  const resetMs = DateTime.toEpochMillis(resetAt.value);
  const snoozeAt = DateTime.make(thread.snoozedUntil ?? "");
  // The recovery worker waits for both the usage reset and any later snooze.
  const reset = DateTime.toDateUtc(
    DateTime.makeUnsafe(
      Option.isSome(snoozeAt) ? Math.max(resetMs, DateTime.toEpochMillis(snoozeAt.value)) : resetMs,
    ),
  );
  const sameDay =
    reset.getFullYear() === now.getFullYear() &&
    reset.getMonth() === now.getMonth() &&
    reset.getDate() === now.getDate();
  const time = reset.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const date = reset.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(reset.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return {
    label: sameDay ? time : `${date}, ${time}`,
    accessibilityLabel: sameDay ? `Resumes at ${time}` : `Resumes ${date}, ${time}`,
    description: `Auto-resume scheduled for ${reset.toLocaleString(undefined, { timeZoneName: "short" })}`,
  };
}
