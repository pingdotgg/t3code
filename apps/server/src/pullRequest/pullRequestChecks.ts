import type { PullRequestCheck } from "@t3tools/contracts";

/** ISO-8601 timestamps in UTC compare correctly as plain text, which is all the ordering needs. */
function isAtLeastAsNew(candidate: string | null, kept: string | null): boolean {
  if (candidate === null) return kept === null;
  return kept === null || candidate >= kept;
}

/**
 * One row per check rather than one per run of it.
 *
 * A host's rollup is a list of runs, not a list of checks: while a workflow is being re-run — or
 * while a second run of it is already live — the same check arrives twice, and both copies reach
 * the reader as what looks like a duplicate. Nothing in a check carries an id, so the name is what
 * identifies it, qualified by the workflow it belongs to since two workflows are free to name a
 * job the same thing.
 *
 * Within a group the newest run is the one worth showing: a re-run is the answer that replaces the
 * one before it, and a run that never said when it happened loses to one that did. A tie goes to
 * whichever came last, because a host lists a re-run after the run it repeats.
 *
 * Failed and cancelled checks come first so the reason for a failing rollup is immediately visible.
 * Within that group and the remaining checks, the order is the host's own, held at the place each
 * check first appeared. A re-run landing mid-read replaces a row where it stands.
 *
 * Two checks that survive under the same name are then genuinely different ones, since they came
 * from different workflows — each is shown as `workflow / name`, the way GitHub writes it itself.
 * A survivor whose workflow the host did not name keeps its bare name rather than being qualified
 * with nothing.
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
    const key = `${entry.workflowName ?? ""} ${entry.check.name}`;
    const kept = newestByCheck.get(key);
    // Re-setting a key a Map already holds keeps its first position, which is the order wanted.
    if (kept === undefined || isAtLeastAsNew(entry.at, kept.at)) newestByCheck.set(key, entry);
  }
  const survivors = [...newestByCheck.values()];
  const countsByName = new Map<string, number>();
  for (const entry of survivors) {
    countsByName.set(entry.check.name, (countsByName.get(entry.check.name) ?? 0) + 1);
  }
  const checks = survivors.map((entry) => {
    const workflowName = entry.workflowName ?? "";
    return workflowName.length > 0 && (countsByName.get(entry.check.name) ?? 0) > 1
      ? { ...entry.check, name: `${workflowName} / ${entry.check.name}` }
      : entry.check;
  });
  return checks.toSorted((left, right) => {
    const leftFailed = left.status === "failure" || left.status === "cancelled";
    const rightFailed = right.status === "failure" || right.status === "cancelled";
    return Number(rightFailed) - Number(leftFailed);
  });
}
