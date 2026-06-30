/**
 * Shared size caps for a persisted/loaded workflow definition. A pure DoS
 * backstop: generous enough that any realistically-authored board round-trips
 * (export → re-import, edit → save, recovery/discovery load from disk), but
 * bounding memory/CPU so neither an untrusted import, an operate-scoped save,
 * NOR a hand-edited on-disk definition can register an arbitrarily large board.
 *
 * Imported by BOTH the import/save path (WorkflowRpcHandlers) and the disk
 * load path (WorkflowFileLoader.loadAndRegister) so the two never diverge.
 * Deliberately decoupled from dryRunBoard's tighter MAX_DRY_RUN_* limits.
 */

import type { WorkflowDefinition } from "@t3tools/contracts";

export const MAX_IMPORT_DEFINITION_CHARS = 2_000_000;
export const MAX_IMPORT_LANES = 1000;
export const MAX_IMPORT_PER_LANE = 1000;

/**
 * Returns a human-readable violation message when `definition` (already decoded)
 * exceeds the lane / per-lane caps, or `null` when it is within bounds. Does NOT
 * check the byte/char cap — that is applied on the raw payload/file string by the
 * caller before decode (see `exceedsDefinitionCharCap`).
 */
export const definitionLaneCapViolation = (definition: WorkflowDefinition): string | null => {
  if (definition.lanes.length > MAX_IMPORT_LANES) {
    return `Board definition is too large (exceeds ${MAX_IMPORT_LANES} lanes)`;
  }
  if (
    definition.lanes.some(
      (lane) =>
        (lane.pipeline?.length ?? 0) > MAX_IMPORT_PER_LANE ||
        (lane.transitions?.length ?? 0) > MAX_IMPORT_PER_LANE ||
        (lane.onEvent?.length ?? 0) > MAX_IMPORT_PER_LANE,
    )
  ) {
    return `Board definition is too large (a lane exceeds ${MAX_IMPORT_PER_LANE} pipeline steps, transitions, or event handlers)`;
  }
  return null;
};

/** True when the raw definition text exceeds the byte/char cap. */
export const exceedsDefinitionCharCap = (rawLength: number): boolean =>
  rawLength > MAX_IMPORT_DEFINITION_CHARS;
