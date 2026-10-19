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

/**
 * A host's rollup is a list of runs, not a list of checks: while a workflow is being re-run — or
 * while a second run of it is already live — the same check arrives twice, and both copies reach
 * the reader as what looks like a duplicate. Nothing in a check carries an id, so the name is what
 * identifies it, qualified by the workflow it belongs to since two workflows are free to name a
 * job the same thing.
 */
export function dedupeChecks(
  entries: ReadonlyArray<{
    readonly check: PullRequestCheck;
    readonly workflowName: string | null;
    readonly at: string | null;
  }>,
): ReadonlyArray<PullRequestCheck> {
  const newestByCheck = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.workflowName ?? "", entry.check.name]);
    const kept = newestByCheck.get(key);
    if (kept === undefined || isAtLeastAsNew(entry.at, kept.at)) newestByCheck.set(key, entry);
  }
  const survivors = [...newestByCheck.values()];
  const countsByName = new Map<string, number>();
  for (const entry of survivors) {
    countsByName.set(entry.check.name, (countsByName.get(entry.check.name) ?? 0) + 1);
  }
  return survivors.map((entry) => {
    const workflowName = entry.workflowName ?? "";
    return workflowName.length > 0 && (countsByName.get(entry.check.name) ?? 0) > 1
      ? { ...entry.check, name: `${workflowName} / ${entry.check.name}` }
      : entry.check;
  });
}
