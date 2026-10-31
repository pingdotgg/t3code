import * as Schema from "effect/Schema";

import { AXES, DEVICE_CLASSES, type AxisId, type DeviceClassId } from "./cases.ts";

const Score = Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 }));
const DeviceScores = Schema.Struct(
  Object.fromEntries(AXES.map((axis) => [axis.id, Score])) as Record<AxisId, typeof Score>,
);

/** The JSON block every reviewer ends its reply with (see brief.md); it scores the captured devices. */
export const ReviewerScores = Schema.Struct({
  scores: Schema.Struct(
    Object.fromEntries(
      DEVICE_CLASSES.map((device) => [device.id, Schema.optionalKey(DeviceScores)]),
    ) as Record<DeviceClassId, Schema.optionalKey<typeof DeviceScores>>,
  ),
  fixes: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
});
export type ReviewerScores = typeof ReviewerScores.Type;

const decodeScores = Schema.decodeUnknownSync(Schema.fromJsonString(ReviewerScores));

/** Reads the last fenced JSON block of a reviewer's reply. */
export function parseReviewerReply(reply: string): ReviewerScores {
  const blocks = [...reply.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) throw new Error("The reply has no ```json block.");
  return decodeScores(last);
}

export function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export type Medians = Partial<Record<DeviceClassId, Record<AxisId, number>>>;

export interface RoundSummary {
  readonly reviewers: Readonly<Record<string, ReviewerScores>>;
  readonly medians: Medians;
}

export function summarizeRound(reviewers: Readonly<Record<string, ReviewerScores>>): RoundSummary {
  const all = Object.values(reviewers);
  const medians: Medians = {};
  for (const device of DEVICE_CLASSES) {
    const scored = all.flatMap((review) => review.scores[device.id] ?? []);
    if (scored.length === 0) continue;
    medians[device.id] = Object.fromEntries(
      AXES.map((axis) => [axis.id, median(scored.map((scores) => scores[axis.id]))]),
    ) as Record<AxisId, number>;
  }
  return { reviewers, medians };
}

const formatScore = (value: number) => (Number.isNaN(value) ? "–" : value.toFixed(1));
const formatDelta = (value: number) =>
  Number.isNaN(value) ? "–" : value === 0 ? "0.0" : `${value > 0 ? "+" : ""}${value.toFixed(1)}`;

/** The summary table: one row per device and axis, with deltas when a baseline is given. */
export function renderSummary(round: RoundSummary, baseline: RoundSummary | null): string {
  const names = Object.keys(round.reviewers);
  const baselineNames = baseline ? Object.keys(baseline.reviewers) : names;
  // A different panel moves the median by itself, so say so next to the deltas.
  const panelNote =
    baselineNames.toSorted().join() === names.toSorted().join()
      ? ""
      : `\nThe baseline panel was ${baselineNames.join(", ")}; this round's is ${names.join(", ")}. Read the deltas with that in mind.\n`;
  const header = ["Device", "Axis", "Median", ...names, ...(baseline ? ["Δ baseline"] : [])];
  const rows = DEVICE_CLASSES.filter((device) => round.medians[device.id]).flatMap((device) =>
    AXES.map((axis) => {
      const value = round.medians[device.id]![axis.id];
      return [
        device.label,
        axis.label,
        formatScore(value),
        ...names.map((name) =>
          formatScore(round.reviewers[name]!.scores[device.id]?.[axis.id] ?? Number.NaN),
        ),
        ...(baseline
          ? [formatDelta(value - (baseline.medians[device.id]?.[axis.id] ?? Number.NaN))]
          : []),
      ];
    }),
  );
  const table = [header, header.map(() => "---"), ...rows]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
  const fixes = names
    .map(
      (name) =>
        `### ${name}\n\n${round.reviewers[name]!.fixes.map((fix, index) => `${index + 1}. ${fix}`).join("\n")}`,
    )
    .join("\n\n");
  return `# Mobile design scores\n${panelNote}\n${table}\n\n## Top fixes\n\n${fixes}\n`;
}
