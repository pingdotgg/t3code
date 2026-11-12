import type { PullRequestCheck } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const zonedDateTimePattern =
  /^(?:\d{4}|[+-]\d{6})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?|24:00(?::00(?:\.0+)?)?)(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

// Parse whole seconds separately so sub-millisecond fractions keep their precision.
function timestampParts(value: string) {
  if (!zonedDateTimePattern.test(value)) return { time: Number.NaN, fraction: "" };
  const fraction = /\.(\d+)(?=Z$|[+-]\d{2}:\d{2}$)/i.exec(value);
  // Date can normalize impossible days. Check the calendar date before applying the offset.
  const datePart = value.split(/[Tt]/, 1)[0] ?? "";
  const date = DateTime.make(`${datePart}T00:00:00Z`);
  const parts = Option.isSome(date) ? DateTime.toPartsUtc(date.value) : null;
  const validDate =
    parts !== null &&
    parts.month === Number(datePart.slice(-5, -3)) &&
    parts.day === Number(datePart.slice(-2));
  return {
    time: validDate ? Date.parse(fraction ? value.replace(fraction[0], "") : value) : Number.NaN,
    fraction: fraction?.[1] ?? "",
  };
}

function isAtLeastAsNew(candidate: string | null, kept: string | null): boolean {
  if (candidate === null) return kept === null;
  if (kept === null) return true;
  const candidateParts = timestampParts(candidate);
  const keptParts = timestampParts(kept);
  if (Number.isNaN(candidateParts.time) || Number.isNaN(keptParts.time)) return candidate >= kept;
  if (candidateParts.time !== keptParts.time) return candidateParts.time > keptParts.time;
  const precision = Math.max(candidateParts.fraction.length, keptParts.fraction.length);
  return (
    candidateParts.fraction.padEnd(precision, "0") >= keptParts.fraction.padEnd(precision, "0")
  );
}

export function sortChecks(
  checks: ReadonlyArray<PullRequestCheck>,
): ReadonlyArray<PullRequestCheck> {
  return checks.toSorted(
    (a, b) =>
      Number(b.status === "failure" || b.status === "cancelled") -
      Number(a.status === "failure" || a.status === "cancelled"),
  );
}

// Runs of one check for different events: a failure outranks a run in progress, which outranks a
// pass, which outranks a run cancelled beside it (a concurrency group superseding it).
function eventSeverity(status: PullRequestCheck["status"]): number {
  if (status === "failure" || status === "action-required") return 3;
  if (status === "pending") return 2;
  return status === "success" ? 1 : 0;
}

/**
 * Rollups repeat checks during reruns or overlapping runs, and checks carry no ids.
 * Identify checks by workflow plus name because different workflows may share job names.
 * Within one event the newest run wins; across events the worse run does.
 */
export function dedupeChecks(
  entries: ReadonlyArray<{
    readonly check: PullRequestCheck;
    readonly workflowName: string | null;
    readonly at: string | null;
    // Hosts with one-second timestamps can date a final and an earlier status alike.
    readonly sequence?: number;
    /** What triggered the run, where the host says (GitHub's `push` or `pull_request`). */
    readonly event?: string | null;
  }>,
): ReadonlyArray<PullRequestCheck> {
  type Entry = (typeof entries)[number];
  const newestByRun = new Map<string, Entry>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.workflowName ?? "", entry.check.name, entry.event ?? null]);
    const kept = newestByRun.get(key);
    if (kept !== undefined) {
      if (!isAtLeastAsNew(entry.at, kept.at)) continue;
      if (
        entry.sequence !== undefined &&
        kept.sequence !== undefined &&
        entry.sequence < kept.sequence &&
        isAtLeastAsNew(kept.at, entry.at)
      )
        continue;
    }
    newestByRun.set(key, entry);
  }
  const newestByCheck = new Map<string, Entry>();
  for (const entry of newestByRun.values()) {
    const key = JSON.stringify([entry.workflowName ?? "", entry.check.name]);
    const kept = newestByCheck.get(key);
    if (kept === undefined) {
      newestByCheck.set(key, entry);
      continue;
    }
    const severity = eventSeverity(entry.check.status) - eventSeverity(kept.check.status);
    const newer = isAtLeastAsNew(entry.at, kept.at);
    // Equal times break on the event, so a reordered rollup cannot flip the run a watch was told.
    const tied = newer && isAtLeastAsNew(kept.at, entry.at);
    const later = tied ? (entry.event ?? "") > (kept.event ?? "") : newer;
    const worse = severity > 0 || (severity === 0 && later);
    const chosen = worse ? entry : kept;
    newestByCheck.set(
      key,
      entry.check.required === true || kept.check.required === true
        ? { ...chosen, check: { ...chosen.check, required: true } }
        : chosen,
    );
  }
  const survivors = [...newestByCheck.values()];
  const countsByName = new Map<string, number>();
  for (const entry of survivors) {
    countsByName.set(entry.check.name, (countsByName.get(entry.check.name) ?? 0) + 1);
  }
  return sortChecks(
    survivors.map((entry) => {
      const workflowName = entry.workflowName ?? "";
      return workflowName.length > 0 && (countsByName.get(entry.check.name) ?? 0) > 1
        ? { ...entry.check, name: `${workflowName} / ${entry.check.name}` }
        : entry.check;
    }),
  );
}
