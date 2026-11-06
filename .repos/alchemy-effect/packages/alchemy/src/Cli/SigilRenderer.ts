import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Interaction from "../Interaction.ts";
import type { Plan } from "../Plan.ts";
import { Cli, type PlanDisplayOptions } from "../Report.ts";
import { renderApply } from "../Report.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import { renderPlanning } from "./commands/render.ts";
import { renderNukeDelete, renderNukeScan, reviewNuke } from "./components/view/Nuke.tsx";
import { stackOutputsView } from "./components/view/StackOutputs.tsx";
import { selectCliServices } from "./selectCli.ts";

/**
 * The CLI's terminal UI for scripts that drive `alchemy/Alchemist`
 * themselves: the Sigil UI on an interactive terminal, plain log lines
 * otherwise, exactly like the CLI.
 *
 * ```ts
 * const plan = yield* Alchemist.plan({ stack, operation: "deploy", stage }).pipe(
 *   SigilRenderer.planning({ operation: "Deploy", stage }),
 * );
 * if (!(yield* SigilRenderer.approve(plan, { stage }))) return;
 * const output = yield* Alchemist.apply(plan).pipe(SigilRenderer.apply(plan, { stage }));
 * yield* SigilRenderer.outputs(output);
 * ```
 */

/** A deploy or destroy plan, or a drift scan, from `alchemy/Alchemist`. */
export interface RenderablePlan {
  readonly native: Plan;
}

/**
 * The CLI's terminal and renderer services, in place of `Alchemist.layer()`'s
 * non-interactive terminal. Provide it after `Alchemist.layer()`:
 * `Effect.provide([Alchemist.layer(), SigilRenderer.layer()])`.
 */
export const layer = () =>
  Layer.provideMerge(selectCliServices(), Interaction.layer()).pipe(
    Layer.provide(PlatformServices),
  );

/** Planning progress (import, services, state, per-resource diffing) around a `plan` call. */
export const planning = renderPlanning;

/**
 * Show the plan and ask to apply it; `true` when approved. Fails with
 * `NonInteractiveTerminal` when there is no terminal to ask on.
 */
export const approve = (plan: RenderablePlan, options?: PlanDisplayOptions) =>
  Effect.flatMap(Cli, (cli) => cli.approvePlan(plan.native, options));

/** Show the plan without asking, as `alchemy plan` does. */
export const display = (plan: RenderablePlan, options?: PlanDisplayOptions) =>
  Effect.flatMap(Cli, (cli) => cli.displayPlan(plan.native, options));

/** Per-resource apply rows around an `apply` call. */
export const apply = (plan: RenderablePlan, options?: PlanDisplayOptions) =>
  renderApply(plan.native, options);

/** Print a deployed stack's outputs. */
export const outputs = (output: unknown) =>
  Effect.flatMap(Interaction.Interaction, (terminal) =>
    terminal.output.print(stackOutputsView(output)),
  );

/** `alchemy unsafe nuke`'s scan progress, review prompt and deletion view. */
export const Nuke = {
  /** Live scan progress around `Alchemist.Nuke.scan`. */
  scan: renderNukeScan,
  /** Show the inventory and ask to delete it; `true` when approved (or `yes`/`dryRun`). */
  review: reviewNuke,
  /** Per-resource deletion rows around `Alchemist.Nuke.execute`. */
  delete: renderNukeDelete,
};
