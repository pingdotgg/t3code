/**
 * Pure validation gates for board-improvement proposals.
 *
 * These run AFTER a structurally-valid proposed definition has been decoded.
 * They are intentionally pure (no Effect, no I/O) so the gate logic is trivially
 * testable; the RPC handler orchestrates them around the (effectful) lint and
 * dry-run calls.
 */

import type { WorkflowDefinition, WorkflowDryRunResult } from "@t3tools/contracts";

/**
 * Canonical JSON for stable structural comparison: the value is round-tripped
 * through JSON so key order from the two definitions does not matter (an object
 * literal preserves insertion order, but we never rely on that here).
 *
 * `undefined` and an empty array are treated as the same "no entries" state so
 * that adding/removing an empty `sources: []` is not flagged as a change.
 */
const canonical = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        out[key] = normalize((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};

const canonicalArray = (value: ReadonlyArray<unknown> | undefined): string =>
  canonical(value ?? []);

export interface PreservationGateResult {
  readonly ok: boolean;
  readonly laneDiffCount: number;
  readonly violations: ReadonlyArray<string>;
}

/**
 * Enforces that a proposal does NOT change the board's `name`, `sources`, or
 * `outbound`. The meta-agent may only reshape lanes/steps/transitions; the
 * board's identity and its external wiring (where work comes from and where
 * results are pushed) are off-limits — those are human-controlled.
 *
 * `laneDiffCount` is a coarse count (lanes added + removed + changed by key)
 * for the review UI; it does not gate anything.
 */
export const preservationGate = (
  baseDef: WorkflowDefinition,
  proposedDef: WorkflowDefinition,
): PreservationGateResult => {
  const violations: Array<string> = [];

  if (baseDef.name !== proposedDef.name) {
    violations.push(
      `Proposal changes the board name ("${baseDef.name}" → "${proposedDef.name}"); the name must be preserved.`,
    );
  }
  if (canonicalArray(baseDef.sources) !== canonicalArray(proposedDef.sources)) {
    violations.push("Proposal changes the board `sources`; sources must be preserved.");
  }
  if (canonicalArray(baseDef.outbound) !== canonicalArray(proposedDef.outbound)) {
    violations.push("Proposal changes the board `outbound` rules; outbound must be preserved.");
  }
  // Board-level `settings` (e.g. maxConcurrentTickets, which sizes the WIP
  // admission semaphore) is external wiring the meta-agent may not touch — it
  // only reshapes lanes/steps/transitions. `canonical` normalizes so an absent
  // `settings` and an empty `{}` compare equal, matching the sources/outbound
  // treatment.
  if (canonical(baseDef.settings ?? {}) !== canonical(proposedDef.settings ?? {})) {
    violations.push("Proposal changes the board `settings`; settings must be preserved.");
  }

  const baseLanes = new Map(baseDef.lanes.map((lane) => [lane.key as string, lane]));
  const proposedLanes = new Map(proposedDef.lanes.map((lane) => [lane.key as string, lane]));

  // The proposed lane-key set MUST be a SUPERSET of the base lane-key set:
  // adding new lanes and tuning anything within a lane (including a lane's
  // display `name`) is fine, but REMOVING or RE-KEYING an existing lane is the
  // most destructive edit a board can take — tickets carry `current_lane_key`
  // and routing references lane keys, so a dropped/re-keyed lane orphans parked
  // tickets and silently changes routing. We forbid it as a hard preservation
  // gate (a removed lane otherwise evades the dry-run regression check, which
  // only walks lanes that still exist in the proposed def). v1 limitation: the
  // agent cannot remove or rename lane keys — a human does that in the editor.
  const removedLaneKeys = [...baseLanes.keys()].filter((key) => !proposedLanes.has(key));
  if (removedLaneKeys.length > 0) {
    violations.push(
      `Proposal removes/renames existing lane(s): ${removedLaneKeys.join(", ")} — not allowed; tickets reference lane keys.`,
    );
  }

  let laneDiffCount = 0;
  for (const [key, lane] of baseLanes) {
    const other = proposedLanes.get(key);
    if (other === undefined) {
      laneDiffCount += 1; // removed
    } else if (canonical(lane) !== canonical(other)) {
      laneDiffCount += 1; // changed
    }
  }
  for (const key of proposedLanes.keys()) {
    if (!baseLanes.has(key)) {
      laneDiffCount += 1; // added
    }
  }

  return { ok: violations.length === 0, laneDiffCount, violations };
};

export interface DryRunRegressionResult {
  readonly ok: boolean;
  readonly regressions: ReadonlyArray<string>;
}

/**
 * Compares paired dry-run results (one entry per {startLane, scenario} combo)
 * between the base and proposed definitions. A regression is a combo whose
 * proposed `end` is a NEW dead end (`no_route` / `cycle_cap`) that the base did
 * NOT already produce for that same combo. A combo that was already broken in
 * the base is not a regression — the proposal can't be blamed for it.
 *
 * The two arrays are expected to be aligned by index (same combos in the same
 * order); the function additionally keys by {startLane, scenario} defensively.
 */
const DEAD_ENDS: ReadonlySet<WorkflowDryRunResult["end"]> = new Set(["no_route", "cycle_cap"]);

export const dryRunRegression = (
  baseResults: ReadonlyArray<WorkflowDryRunResult>,
  proposedResults: ReadonlyArray<WorkflowDryRunResult>,
): DryRunRegressionResult => {
  const comboKey = (r: WorkflowDryRunResult): string => `${r.startLane as string}::${r.scenario}`;
  const baseByCombo = new Map(baseResults.map((r) => [comboKey(r), r]));
  const regressions: Array<string> = [];

  for (const proposed of proposedResults) {
    if (!DEAD_ENDS.has(proposed.end)) {
      continue;
    }
    const base = baseByCombo.get(comboKey(proposed));
    // A combo already dead-ended in the base is pre-existing, not a regression.
    if (base !== undefined && DEAD_ENDS.has(base.end)) {
      continue;
    }
    regressions.push(
      `Starting in lane "${proposed.startLane as string}" with a ${proposed.scenario} outcome now ends in "${proposed.end}" (was "${base?.end ?? "n/a"}").`,
    );
  }

  return { ok: regressions.length === 0, regressions };
};
