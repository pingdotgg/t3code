import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { apply as applyPlan } from "../../Apply.ts";
import * as Plan from "../../Plan.ts";
import type { PlannedAction, PlannedResource } from "../../Report.ts";
import { applySession, Progress, withSpanEvents } from "../Progress.ts";
import { open, type Session, type StackTarget } from "../Session.ts";

export type { StackTarget } from "../Session.ts";

export interface PlanInput {
  readonly target: StackTarget;
  readonly operation: "deploy" | "destroy";
  readonly force?: boolean;
  readonly adopt?: boolean;
  readonly updateStateStore?: boolean;
  /** Run local (emulated) providers instead of the real cloud. */
  readonly dev?: boolean;
}

/** Infer the deployed stack output from an `alchemy.run.ts` module type. */
export type StackModuleOutput<Module> = Module extends {
  readonly default: infer Definition;
}
  ? Definition extends Effect.Effect<any, any, any>
    ? Effect.Success<Definition> extends { readonly output: infer Output }
      ? Output
      : unknown
    : unknown
  : unknown;

export interface PlanSummary {
  readonly create: number;
  readonly update: number;
  readonly adopted: number;
  readonly replace: number;
  readonly delete: number;
  readonly orphaned: number;
  readonly noop: number;
}

export interface PlanSnapshot<Output = unknown> {
  readonly stack: { readonly name: string; readonly stage: string };
  readonly summary: PlanSummary;
  /**
   * Serializable resource rows (including orphan deletions) with their
   * bindings and provider modes — what a remote renderer shows without
   * holding {@link PlanSnapshot.native}.
   */
  readonly resources: ReadonlyArray<PlannedResource>;
  /** Serializable stack-action rows. */
  readonly actions: ReadonlyArray<PlannedAction>;
  /** The engine plan, as consumed by in-process renderers and {@link apply}. */
  readonly native: Plan.Plan<Output>;
  readonly createdAt: Date;
  /** The session this plan was computed under; {@link apply} runs in it. */
  readonly session: Session;
}

/** Whether a plan proposes any cloud mutations (i.e. approval-worthy work). */
export const hasChanges = (summary: PlanSummary): boolean =>
  summary.create +
    summary.update +
    summary.adopted +
    summary.replace +
    summary.delete +
    summary.orphaned >
  0;

export const summarize = (plan: Plan.Plan): PlanSummary => {
  const summary: { -readonly [K in keyof PlanSummary]: PlanSummary[K] } = {
    create: 0,
    update: 0,
    adopted: 0,
    replace: 0,
    delete: 0,
    orphaned: 0,
    noop: 0,
  };
  for (const node of Object.values(plan.resources)) summary[node.action]++;
  for (const node of Object.values(plan.deletions)) {
    if (node !== undefined) summary[node.action]++;
  }
  return summary;
};

/**
 * Import the stack, resolve its services, and compute a deploy or destroy
 * plan. Planning phases are reported through {@link Progress}; the returned
 * snapshot is what {@link apply} executes.
 */
export const plan = Effect.fn("Alchemist.stack.plan")(function* <
  Module = unknown,
>(input: PlanInput) {
  type Output = StackModuleOutput<Module>;
  const report = withSpanEvents(yield* Progress);

  // Everything below emits into the same flat ProgressEvent channel:
  // `open` reports importing-module / resolving-services at the real work
  // boundaries, the engine reports loading-state / computing-plan and the
  // per-node diff events. Re-providing the wrapped reporter is all the
  // route does — no translation layer.
  const session = yield* open(input.target, input).pipe(
    Effect.provideService(Progress, report),
  );
  const native = (yield* (
    input.operation === "destroy"
      ? Plan.destroy(session.stack)
      : Plan.make(session.stack, { force: input.force })
  ).pipe(
    Effect.provideService(Progress, report),
    Effect.provide(session.context),
  )) as Plan.Plan<Output>;
  yield* report({ _tag: "plan.phase", phase: "plan-ready" });
  return {
    stack: { name: session.stack.name, stage: session.stack.stage },
    summary: summarize(native),
    ...Plan.describePlan(native),
    native,
    createdAt: new Date(yield* Clock.currentTimeMillis),
    session,
  } satisfies PlanSnapshot<Output>;
});

/**
 * Apply a computed plan. Engine apply events are reported through
 * {@link Progress} as `ApplyEvent`.
 */
export const apply = Effect.fn("Alchemist.stack.apply")(function* <Output>(
  snapshot: PlanSnapshot<Output>,
) {
  const report = withSpanEvents(yield* Progress);
  return yield* Effect.provide(
    applyPlan(snapshot.native, { session: applySession(report) }),
    snapshot.session.context,
  );
});
