import * as NodeUtil from "node:util";
import type {
  PullRequestCheck,
  PullRequestCheckFailure,
  PullRequestCheckStatus,
  PullRequestChecksState,
} from "@t3tools/contracts";
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

/** action-required is a finished check needing human input. */
export const isFailedCheck = (check: Pick<PullRequestCheck, "status">) =>
  check.status === "failure" || check.status === "cancelled" || check.status === "action-required";

export function rollupCheckStatuses(
  statuses: ReadonlyArray<PullRequestCheckStatus>,
): PullRequestChecksState | null {
  if (statuses.length === 0) return null;
  if (statuses.includes("failure") || statuses.includes("cancelled")) return "failing";
  if (statuses.includes("pending") || statuses.includes("action-required")) return "pending";
  return statuses.includes("success") ? "passing" : null;
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

/**
 * Rollups repeat checks during reruns or overlapping runs, each with its own handle.
 * Identify checks by workflow plus name because different workflows may share job names.
 */
export function dedupeChecks(
  entries: ReadonlyArray<{
    readonly check: PullRequestCheck;
    readonly workflowName: string | null;
    readonly at: string | null;
    // Hosts with one-second timestamps can date a final and an earlier status alike.
    readonly sequence?: number;
  }>,
): ReadonlyArray<PullRequestCheck> {
  const newestByCheck = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.workflowName ?? "", entry.check.name]);
    const kept = newestByCheck.get(key);
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
    newestByCheck.set(key, entry);
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

export const CHECK_LOG_EXCERPT_BUDGET = {
  maxLines: 80,
  maxBytes: 8192,
  context: 3,
  tail: 20,
} as const;
type Line = { index: number; text: string };

// A failed composite step's end marker is the only record of which nested step failed.
const isLogNoise = (text: string) =>
  (/^\s*(?:❯|at)\s/.test(text) && /node_modules[\\/]/.test(text)) ||
  /^##\[start-action /.test(text) ||
  /^##\[end-action .*outcome=(?:success|skipped)\b/.test(text) ||
  /^(?:Post job cleanup\.|Cleaning up orphan processes)/.test(text);

export class CheckLogExcerpt {
  private pending = "";
  private totalLines = 0;
  private noiseLines = 0;
  private clipped = false;
  private afterError = 0;
  private header: Line | undefined;
  private tail: Line[] = [];
  private failedTail: Line[] = [];
  private failedSection = false;
  private selected = new Map<number, Line>();

  write(chunk: string): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf("\n", start);
      const part = chunk.slice(start, end < 0 ? undefined : end);
      const room = CHECK_LOG_EXCERPT_BUDGET.maxBytes - this.pending.length;
      this.pending += part.slice(0, room);
      if (part.length > room) this.clipped = true;
      if (end < 0) break;
      this.line(this.pending);
      this.pending = "";
      start = end + 1;
    }
  }

  private line(raw: string): void {
    const line = {
      index: this.totalLines++,
      text: NodeUtil.stripVTControlCharacters(raw)
        .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "")
        .replace(/\r$/, ""),
    };
    if (isLogNoise(line.text)) {
      this.noiseLines++;
      return;
    }
    // Step names do not appear in the log; a section failed when it carries ##[error].
    if (line.text.startsWith("##[group]Run ")) {
      if (this.failedSection) this.failedTail = this.tail;
      this.tail = [];
      this.header = line;
      this.failedSection = false;
    }
    if (line.text.includes("##[error]")) {
      this.failedSection = true;
      if (this.header) this.selected.set(this.header.index, this.header);
      for (const prior of this.tail.slice(-CHECK_LOG_EXCERPT_BUDGET.context))
        this.selected.set(prior.index, prior);
      this.afterError = CHECK_LOG_EXCERPT_BUDGET.context + 1;
    }
    if (this.afterError > 0) {
      this.selected.set(line.index, line);
      this.afterError--;
    }
    while (this.selected.size > CHECK_LOG_EXCERPT_BUDGET.maxLines) {
      this.selected.delete(this.selected.keys().next().value!);
    }
    this.tail.push(line);
    if (this.tail.length > CHECK_LOG_EXCERPT_BUDGET.tail) this.tail.shift();
  }

  finish(): Extract<PullRequestCheckFailure["log"], { _tag: "excerpt" }> {
    if (this.pending.length > 0) {
      this.line(this.pending);
      this.pending = "";
    }
    const tail = this.failedSection || this.failedTail.length === 0 ? this.tail : this.failedTail;
    const kept = new Map<number, string>();
    let bytes = 0;
    const keep = (line: Line): boolean => {
      if (kept.has(line.index)) return true;
      const room = CHECK_LOG_EXCERPT_BUDGET.maxBytes - bytes - (kept.size > 0 ? 1 : 0);
      if (kept.size >= CHECK_LOG_EXCERPT_BUDGET.maxLines || room <= 0) return false;
      let text = line.text;
      if (Buffer.byteLength(text) > room) {
        text = new TextDecoder("utf-8", { fatal: false }).decode(
          Buffer.from(text).subarray(0, room),
        );
        while (Buffer.byteLength(text) > room) text = text.slice(0, -1);
        this.clipped = true;
      }
      bytes += Buffer.byteLength(text) + (kept.size > 0 ? 1 : 0);
      kept.set(line.index, text);
      return true;
    };
    // Error windows explain the failure; the tail only shows where it stopped.
    const windows = [...this.selected.values()].sort((a, b) => b.index - a.index);
    for (const line of windows) if (!keep(line)) break;
    for (const line of tail.toReversed()) if (!keep(line)) break;
    const lines = [...kept].sort(([a], [b]) => a - b).map(([, text]) => text);
    return {
      _tag: "excerpt",
      text: lines.join("\n"),
      totalLines: this.totalLines,
      truncated: this.clipped || lines.length < this.totalLines - this.noiseLines,
    };
  }
}

export function excerptCheckLog(chunks: Iterable<string>) {
  const excerpt = new CheckLogExcerpt();
  for (const chunk of chunks) excerpt.write(chunk);
  return excerpt.finish();
}
