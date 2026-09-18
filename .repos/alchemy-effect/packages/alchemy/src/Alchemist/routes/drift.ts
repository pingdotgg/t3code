import * as Effect from "effect/Effect";
import * as EngineDrift from "../../Drift.ts";
import type { Plan } from "../../Plan.ts";
import { applySession, Progress, withSpanEvents } from "../Progress.ts";
import { open, type Session, type StackTarget } from "../Session.ts";
import * as Stack from "./stack.ts";

export interface DriftedResource {
  readonly fqn: string;
  readonly logicalId: string;
  readonly resourceType: string;
  readonly status: "in-sync" | "drifted" | "missing";
  readonly actual?: unknown;
}

export interface DriftSnapshot {
  readonly stack: { readonly name: string; readonly stage: string };
  readonly resources: ReadonlyArray<DriftedResource>;
  readonly repairPlan: {
    readonly summary: Stack.PlanSummary;
    readonly native: Plan;
  };
  /** The session drift was inspected under; {@link repair} runs in it. */
  readonly session: Session;
}

/** Whether the drift check found anything worth repairing. */
export const hasDrift = (snapshot: DriftSnapshot): boolean =>
  snapshot.resources.some(
    (resource) =>
      resource.status === "drifted" || resource.status === "missing",
  );

const status = (action: string) =>
  action === "unchanged"
    ? ("in-sync" as const)
    : action === "missing"
      ? ("missing" as const)
      : ("drifted" as const);

/** Compare deployed state against the real cloud and plan the repair. */
export const inspect = Effect.fn("Alchemist.drift.inspect")(function* (
  target: StackTarget,
) {
  const report = withSpanEvents(yield* Progress);
  // `open` emits importing-module / resolving-services at the real work
  // boundaries; hand it the wrapped reporter so they land in traces too.
  const session = yield* open(target).pipe(
    Effect.provideService(Progress, report),
  );
  const identity = {
    name: session.stack.name,
    stage: session.stack.stage,
  };
  const { result, plan } = yield* EngineDrift.plan(identity).pipe(
    // The engine's phase and per-resource observation events flow through
    // the same wrapped reporter; drift-flavored wording is the renderer's
    // job (renderPlanning's computingLabel).
    Effect.provideService(Progress, report),
    Effect.provide(session.context),
  );
  yield* report({ _tag: "plan.phase", phase: "plan-ready" });
  return {
    stack: identity,
    resources: Object.values(result.resources)
      .filter((resource) => resource.action !== "skipped")
      .map((resource) => ({
        fqn: resource.fqn,
        logicalId: resource.logicalId,
        resourceType: resource.resourceType,
        status: status(resource.action),
        actual: resource.attr,
      })),
    repairPlan: { summary: Stack.summarize(plan), native: plan },
    session,
  } satisfies DriftSnapshot;
});

/**
 * Converge state back to the cloud's actual shape. Engine apply events are
 * reported through {@link Progress}.
 */
export const repair = Effect.fn("Alchemist.drift.repair")(function* (
  snapshot: DriftSnapshot,
) {
  const report = withSpanEvents(yield* Progress);
  return yield* Effect.provide(
    EngineDrift.repair(
      { name: snapshot.stack.name, stage: snapshot.stack.stage },
      { session: applySession(report) },
    ),
    snapshot.session.context,
  );
});
