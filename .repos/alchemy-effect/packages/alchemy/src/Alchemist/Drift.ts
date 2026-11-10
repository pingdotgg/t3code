import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as EngineDrift from "../Drift.ts";
import { emit } from "../Events.ts";
import type { Plan } from "../Plan.ts";
import type { ConfiguredStack } from "../Stack.ts";
import type { State } from "../State/State.ts";
import {
  buildWithoutProgram,
  summarize,
  type BuildOptions,
  type PlanSummary,
} from "./Operations.ts";

export interface DriftedResource {
  readonly fqn: string;
  readonly logicalId: string;
  readonly resourceType: string;
  /** `skipped`: not checked (no `read`, or an interrupted deploy); see `reason`. */
  readonly status: "in-sync" | "drifted" | "missing" | "skipped";
  readonly reason?: string;
  readonly actual?: unknown;
}

/** A drift check and the repair it proposes; only {@link execute} runs it. */
export interface DriftScan {
  readonly stack: { readonly name: string; readonly stage: string };
  readonly resources: ReadonlyArray<DriftedResource>;
  /** What the repair would change. */
  readonly summary: PlanSummary;
  /**
   * The repair as an engine plan, for renderers.
   * @internal its shape may change.
   */
  readonly native: Plan;
  /**
   * The stack services drift was checked under.
   * @internal {@link execute} runs in them.
   */
  readonly context: Context.Context<State>;
}

export interface ScanOptions extends BuildOptions {
  readonly stack: ConfiguredStack<unknown, unknown>;
}

/** Whether the drift check found anything worth repairing. */
export const hasDrift = (scan: DriftScan): boolean =>
  scan.resources.some((resource) => resource.status === "drifted" || resource.status === "missing");

const status = (action: string): DriftedResource["status"] =>
  action === "unchanged"
    ? "in-sync"
    : action === "missing" || action === "skipped"
      ? action
      : "drifted";

/**
 * Compare deployed state against the real cloud and plan the repair. Drift
 * reads state and providers only, so the stack's program never runs.
 */
export const scan = Effect.fn("Alchemist.Drift.scan")(function* (input: ScanOptions) {
  const built = yield* buildWithoutProgram(input.stack, input);
  const identity = {
    name: built.stack.name,
    stage: built.stack.stage,
  };
  // The engine's phase and per-resource observation events flow through the
  // log as events; drift-flavored wording is the renderer's job
  // (renderPlanning's computingLabel).
  const { result, plan } = yield* EngineDrift.plan(identity).pipe(Effect.provide(built.context));
  yield* emit({ type: "plan.phase", phase: "plan-ready" });
  return {
    stack: identity,
    resources: Object.values(result.resources).map((resource) => ({
      fqn: resource.fqn,
      logicalId: resource.logicalId,
      resourceType: resource.resourceType,
      status: status(resource.action),
      reason: resource.reason,
      actual: resource.attr,
    })),
    summary: summarize(plan),
    native: plan,
    context: built.context,
  } satisfies DriftScan;
});

/**
 * Repair the drift `scan` found: reconcile each drifted or missing resource
 * back to its last-deployed desired state. Only those resources are touched;
 * they are re-read first, so one that is back in sync is left alone, and
 * drift that appeared after the scan waits for the next one.
 */
export const execute = Effect.fn("Alchemist.Drift.execute")(function* (scan: DriftScan) {
  const only = scan.resources
    .filter((resource) => resource.status === "drifted" || resource.status === "missing")
    .map((resource) => resource.fqn);
  return yield* Effect.provide(
    EngineDrift.repair({ name: scan.stack.name, stage: scan.stack.stage }, { only }),
    scan.context,
  );
});
