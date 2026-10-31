/** Pure grading for the mobile behavior eval: frame and scroll math, checks, and the summary. */
import type { FeedSample } from "./device.ts";

export type Metrics = Readonly<Record<string, number | boolean | string | null>>;

export interface Check {
  readonly metric: string;
  readonly max?: number;
  readonly min?: number;
  readonly equals?: number | boolean | string | null;
}

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;

export function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const round = (value: number, digits = 1) => Number(value.toFixed(digits));

/**
 * Frame times from rAF timestamps, graded against the display's budget: `refreshMs` when given,
 * else 120 Hz when the fastest frames come under 12 ms and 60 Hz otherwise. A steady low frame
 * rate still counts as dropped frames. `dropped` counts the frames that should have run inside
 * each long gap.
 */
export function frameStats(
  timestamps: ReadonlyArray<number>,
  prefix: string,
  refreshMs?: number,
): Metrics {
  const gaps = timestamps.slice(1).map((time, index) => time - timestamps[index]!);
  if (gaps.length < 10) return { [`${prefix}Frames`]: gaps.length };
  const sorted = [...gaps].sort((a, b) => a - b);
  const refresh = refreshMs ?? (percentile(sorted, 0.05) < 12 ? 1000 / 120 : 1000 / 60);
  const dropped = gaps.reduce(
    (total, gap) => total + Math.max(0, Math.round(gap / refresh) - 1),
    0,
  );
  return {
    [`${prefix}Frames`]: gaps.length,
    [`${prefix}RefreshHz`]: Math.round(1000 / refresh),
    [`${prefix}P50Ms`]: round(percentile(sorted, 0.5)),
    [`${prefix}P95Ms`]: round(percentile(sorted, 0.95)),
    [`${prefix}P99Ms`]: round(percentile(sorted, 0.99)),
    [`${prefix}MaxMs`]: round(sorted.at(-1)!),
    [`${prefix}DroppedPct`]: round((100 * dropped) / (gaps.length + dropped)),
  };
}

/** Fastest real fling step: about 8000 pt/s at 60 Hz. A bigger one-frame move is a jump. */
export const TELEPORT_PX = 400;

/**
 * How visible rows moved between JS frames. A row's screen y is its list position minus the
 * scroll offset, so a list that shifts its offset to hold content still reads as no motion.
 * `direction` is the way rows should move: +1 while dragging content down (scrolling up).
 */
export function feedMotion(samples: ReadonlyArray<FeedSample>, direction: 1 | -1 | 0): Metrics {
  let backward = 0;
  let largest = 0;
  let teleports = 0;
  let moved = 0;
  for (let index = 1; index < samples.length; index++) {
    const before = samples[index - 1]!;
    const after = samples[index]!;
    const shared = Object.keys(before.rows ?? {}).filter((key) => after.rows?.[key] !== undefined);
    let step = 0;
    for (const key of shared) {
      const rowStep = after.rows![key]! - before.rows![key]!;
      if (Math.abs(rowStep) > Math.abs(step)) step = rowStep;
    }
    // A jump can replace every visible row; with the same content, the offset change is the move.
    if (shared.length === 0 && before.content === after.content)
      step = (before.scroll ?? 0) - (after.scroll ?? 0);
    moved += Math.abs(step);
    largest = Math.max(largest, Math.abs(step));
    if (Math.abs(step) > TELEPORT_PX) teleports++;
    if (direction !== 0) backward = Math.max(backward, -step * direction);
  }
  const fromEnd = samples.flatMap((sample) =>
    sample.fromEnd === undefined ? [] : [sample.fromEnd],
  );
  return {
    samples: samples.length,
    movedPx: Math.round(moved),
    backwardPx: Math.round(backward),
    largestStepPx: Math.round(largest),
    teleports,
    maxFromEndPx: fromEnd.length ? Math.max(...fromEnd) : null,
    finalFromEndPx: fromEnd.at(-1) ?? null,
  };
}

export function checkFails(check: Check, metrics: Metrics): string | null {
  const value = metrics[check.metric];
  if (value === undefined) return `${check.metric} missing`;
  if (check.equals !== undefined)
    return value === check.equals ? null : `${check.metric}=${value}, want ${check.equals}`;
  if (typeof value !== "number") return `${check.metric}=${value}, want a number`;
  if (check.max !== undefined && value > check.max)
    return `${check.metric}=${value} > ${check.max}`;
  if (check.min !== undefined && value < check.min)
    return `${check.metric}=${value} < ${check.min}`;
  return null;
}

export interface SampleRow {
  readonly id: string;
  readonly device: string;
  readonly sample: number;
  readonly pass: boolean | null;
  readonly failures: ReadonlyArray<string>;
  readonly metrics: Metrics;
  /** Why the sample has no grade: the scenario failed before it could measure. */
  readonly error?: string;
}

export interface CaseResult {
  readonly id: string;
  readonly device: string;
  readonly samples: number;
  readonly passed: number;
  readonly errors: number;
  /**
   * `null` when too few samples were graded: errors outnumber graded samples, or none ran.
   * Otherwise a case fails when half or more of its graded samples fail.
   */
  readonly pass: boolean | null;
  readonly key: number | boolean | string | null;
}

export function caseResult(
  id: string,
  device: string,
  key: string,
  rows: ReadonlyArray<SampleRow>,
): CaseResult {
  const graded = rows.filter((row) => row.pass !== null);
  const errors = rows.filter((row) => row.error !== undefined).length;
  const passed = graded.filter((row) => row.pass).length;
  const values = graded.map((row) => row.metrics[key]);
  const numbers = values.filter((value): value is number => typeof value === "number");
  return {
    id,
    device,
    samples: graded.length,
    passed,
    errors,
    pass: graded.length === 0 || errors > graded.length ? null : passed > graded.length / 2,
    key:
      numbers.length === values.length && numbers.length > 0
        ? round(median(numbers))
        : (values[Math.floor(values.length / 2)] ?? null),
  };
}

const mark = (result: CaseResult) =>
  `${result.pass === null ? "incomplete" : result.pass ? "pass" : "FAIL"} ${result.passed}/${result.samples + result.errors}`;

/** Markdown scoreboard. With a baseline, each row shows the earlier result. */
export function summarize(input: {
  readonly cases: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly source: string;
    readonly key: string;
  }>;
  readonly results: ReadonlyArray<CaseResult>;
  readonly baseline?: ReadonlyArray<CaseResult>;
  readonly header: string;
}): string {
  const devices = [...new Set(input.results.map((result) => result.device))];
  const cell = (result: CaseResult | undefined) =>
    result ? `${mark(result)} (${result.key ?? "-"})` : "-";
  const lines = [
    input.header,
    "",
    `| Case | Kind | Source | Key metric | ${devices.join(" | ")} |`,
    `| --- | --- | --- | --- | ${devices.map(() => "---").join(" | ")} |`,
  ];
  for (const testCase of input.cases) {
    const cells = devices.map((device) => {
      const now = input.results.find((r) => r.id === testCase.id && r.device === device);
      const before = input.baseline?.find((r) => r.id === testCase.id && r.device === device);
      return before ? `${cell(now)} was ${cell(before)}` : cell(now);
    });
    if (cells.every((value) => value === "-")) continue;
    lines.push(
      `| \`${testCase.id}\` | ${testCase.kind} | ${testCase.source} | ${testCase.key} | ${cells.join(" | ")} |`,
    );
  }
  const ran = input.results.filter((result) => result.pass !== null);
  const incomplete = input.results.length - ran.length;
  lines.push(
    "",
    `${ran.filter((r) => r.pass).length} of ${ran.length} case runs pass${incomplete ? `, ${incomplete} incomplete` : ""}.`,
  );
  return `${lines.join("\n")}\n`;
}

export function resultsFor(
  rows: ReadonlyArray<SampleRow>,
  cases: ReadonlyArray<{ readonly id: string; readonly key: string }>,
): ReadonlyArray<CaseResult> {
  const keys = [...new Set(rows.map((row) => `${row.id}\u0000${row.device}`))];
  return keys.map((key) => {
    const [id, device] = key.split("\u0000") as [string, string];
    return caseResult(
      id,
      device,
      cases.find((entry) => entry.id === id)?.key ?? "",
      rows.filter((row) => row.id === id && row.device === device),
    );
  });
}

/**
 * Results that should stop a release: a guard or control that failed or could not be graded.
 * `bad` cases reproduce known bugs and fail until those are fixed.
 */
export function blockingResults(
  results: ReadonlyArray<CaseResult>,
  cases: ReadonlyArray<{ readonly id: string; readonly kind: string }>,
): ReadonlyArray<CaseResult> {
  return results.filter(
    (result) =>
      result.pass !== true && cases.find((entry) => entry.id === result.id)?.kind !== "bad",
  );
}
