/** @jsxImportSource react */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Plan } from "../../../Plan.ts";
import { type PlanStatusSession, Cli } from "../../../Report.ts";
import { CliKit } from "../../CliKit/index.ts";
import type { ApplyEvent } from "../../../Report.ts";
import { formatElapsed } from "../../Format.ts";
import { approvePlanScreen } from "./ApprovePlan.tsx";
import { Plan as PlanComponent, PlanTree } from "./PlanView.tsx";

/**
 * UI choices that outlive a single apply session. `alchemy dev` opens a new
 * session (and a new plan widget) on every hot reload; without this the
 * widget would reappear after the user hid it with `p`.
 */
interface SessionPreferences {
  planExpanded: boolean;
}

export const sigilCli = () =>
  Layer.effect(
    Cli,
    Effect.map(CliKit, (cli) => {
      const preferences: SessionPreferences = { planExpanded: true };
      return Cli.of({
        startPlanningSession: (label, detail, title) =>
          startPlanningSession(cli, label, detail, title),
        approvePlan: (plan, options) => approvePlan(cli, plan, options),
        displayPlan: (plan, options) => displayPlan(cli, plan, options),
        startApplySession: (plan, options) =>
          startApplySession(cli, plan, options, preferences),
      });
    }),
  );

const approvePlan = Effect.fn(function* <P extends Plan>(
  cli: CliKit["Service"],
  plan: P,
  options?: import("../../../Report.ts").PlanDisplayOptions,
) {
  // A dismissed screen means "declined"; NonInteractiveTerminal propagates
  // typed to the command-level handlers (a friendly line, not a raw cause).
  return yield* cli.prompt
    .custom(approvePlanScreen(plan, options?.detailed))
    .pipe(Effect.catchTag("TerminalCancelled", () => Effect.succeed(false)));
});

const displayPlan = Effect.fn(function* <P extends Plan>(
  cli: CliKit["Service"],
  plan: P,
  options?: import("../../../Report.ts").PlanDisplayOptions,
) {
  const tree = new PlanTree(plan, {
    detailed: options?.detailed,
    mode: "review",
    label: "Plan",
    viewport: "full",
  });
  yield* cli.output.print(<PlanComponent tree={tree} />);
});

const startPlanningSession = Effect.fn(function* (
  cli: CliKit["Service"],
  label: string,
  detail?: string,
  title?: string,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const scope = yield* Scope.make();
  const progress = yield* cli.live
    .progress({
      label,
      detail,
      title: title === undefined ? undefined : `${label} · ${title}`,
      spinning: false,
    })
    .pipe(Scope.provide(scope));
  let closed = false;
  const finish = (effect: Effect.Effect<void>) =>
    Effect.suspend(() => {
      if (closed) return Effect.void;
      closed = true;
      return effect.pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
    });
  // Settle messages carry the total planning duration, mirroring the plain
  // renderer's "(1.8s)" suffix.
  const settled = (message: string | undefined) =>
    message === undefined
      ? Effect.succeed(undefined)
      : Clock.currentTimeMillis.pipe(
          Effect.map((now) => `${message} (${formatElapsed(now - startedAt)})`),
        );
  return {
    update: (
      nextLabel: string,
      nextDetail?: string,
      options?: { readonly spinning?: boolean },
    ) =>
      progress.update({
        label: nextLabel,
        detail: nextDetail,
        title: title === undefined ? undefined : `${nextLabel} · ${title}`,
        spinning: options?.spinning ?? true,
      }),
    succeed: (message?: string) =>
      finish(Effect.flatMap(settled(message), progress.succeed)),
    fail: (message?: string) =>
      finish(Effect.flatMap(settled(message), progress.fail)),
    close: finish(progress.close),
  };
});

const startApplySession = Effect.fn(function* <P extends Plan>(
  cli: CliKit["Service"],
  plan: P,
  options: import("../../../Report.ts").PlanDisplayOptions | undefined,
  preferences: SessionPreferences,
) {
  // Detailed applies render their YAML diffs inline in the progress tree.
  // One-shot operations persist the final render; dev keeps its live block
  // mounted so logs remain static above the collapsible plan and keybar.
  const labels = plan.destroy
    ? {
        active: "Destroying stack",
        success: "Stack destroyed",
        failure: "Destroy failed",
      }
    : plan.defaultMode === "local"
      ? {
          active: "Starting dev stack",
          success: "Dev stack ready",
          failure: "Dev startup failed",
        }
      : {
          active: "Deploying stack",
          success: "Stack deployed",
          failure: "Deploy failed",
        };
  const progress = new PlanTree(plan, {
    detailed: options?.detailed,
    mode: "apply",
    label: labels.active,
    titleDetail: options?.stage,
    busy: true,
    expanded: preferences.planExpanded,
  });
  // Remember the collapse toggle as it happens, so the next hot-reload
  // generation opens the way the user left this one.
  progress.subscribe(() => {
    preferences.planExpanded = progress.snapshot().expanded;
  });
  // The session outlives this effect — the caller settles it via `done` on
  // every exit path (Apply.ts's onExit). live.open is Scope-bound, so give
  // it a manually managed scope. One-shot operations close it in `done`;
  // dev retains it after `done` and tears it down through `close` when the
  // generation is interrupted (a reload or Ctrl+C), so a replaced
  // generation never leaves its widget behind.
  const scope = yield* Scope.make();
  const live = yield* cli.live
    .open(<PlanComponent tree={progress} collapsible={options?.dev} />, {
      persistOnClose: !options?.dev,
    })
    .pipe(Scope.provide(scope));
  const close = live.close.pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
  return {
    done: (outcome) =>
      Effect.sync(() => {
        const outputReady = progress.snapshot().output !== undefined;
        progress.finish(
          outcome,
          labels[outcome],
          options?.dev && outcome === "success" && outputReady
            ? "output"
            : "plan",
        );
        if (!options?.dev) progress.setViewport("full");
      }).pipe(Effect.andThen(options?.dev ? Effect.void : close)),
    close,
    emit: (event: ApplyEvent) => Effect.sync(() => progress.emit(event)),
    setOutput: (value: unknown) => Effect.sync(() => progress.setOutput(value)),
  } satisfies PlanStatusSession;
});
