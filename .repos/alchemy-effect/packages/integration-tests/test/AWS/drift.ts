import type { ScratchStack } from "@alchemy.run/test/Alchemy";
import * as Drift from "alchemy/Drift";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const target = (stack: ScratchStack) => ({ name: stack.name, stage: stack.stage });

/** `alchemy drift` for one resource of a scratch stack. */
export const driftOf = (stack: ScratchStack, logicalId: string) =>
  Drift.detect(target(stack)).pipe(
    Effect.map((result) => result.resources[logicalId]),
    Effect.provide(stack.state),
  );

/** The drift action of every resource in a scratch stack, by logical id. */
export const driftActions = (stack: ScratchStack) =>
  Drift.detect(target(stack)).pipe(
    Effect.map((result) =>
      Object.fromEntries(
        Object.entries(result.resources).map(([id, resource]) => [id, resource?.action]),
      ),
    ),
    Effect.provide(stack.state),
  );

/**
 * Re-run drift detection until the resource reads as `expected`, so an
 * out-of-band change has time to become visible (or a repair to settle).
 */
export const waitForDrift = (stack: ScratchStack, logicalId: string, expected: Drift.DriftAction) =>
  driftOf(stack, logicalId).pipe(
    Effect.repeat({
      until: (result) => result?.action === expected,
      schedule: Schedule.spaced("2 seconds"),
      times: 15,
    }),
  );

/** `alchemy drift --repair` for a scratch stack. */
export const repairDrift = (stack: ScratchStack) =>
  Drift.repair(target(stack)).pipe(Effect.provide(stack.state));
