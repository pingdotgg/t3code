import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { onEvent, type ApplyEvent, type NoteKind } from "./Events.ts";
import type { NonInteractiveTerminal } from "./Interaction.ts";
import type { Plan } from "./Plan.ts";

// The presentation contract: the renderer interfaces a presentation layer
// (the bundled CLI, a custom renderer, tests) implements, and `renderApply`,
// which feeds a plan's apply events to the ambient one. The engine only
// emits events (Events.ts); nothing in here knows about terminals.

/** A renderer drawing one plan's apply, fed by {@link renderApply}. */
export interface PlanStatusSession {
  emit: (event: ApplyEvent) => Effect.Effect<void>;
  done: (outcome: "success" | "failure") => Effect.Effect<void>;
  /** Replace the dev widget's stack output view without writing scrollback. */
  setOutput?: (value: unknown) => Effect.Effect<void>;
  /**
   * Tear down the session's live presentation without settling it. Dev keeps
   * its widget mounted after `done`; an interrupted generation (reload,
   * Ctrl+C) must remove it so the next generation does not stack another.
   */
  close?: Effect.Effect<void>;
}

export interface PlanningStatusSession {
  update: (
    label: string,
    detail?: string,
    options?: {
      /**
       * Animate the status glyph. Pass `false` for phases whose work runs
       * synchronously on the main thread (e.g. module import) — a spinner
       * cannot animate while the event loop is blocked, so it freezes
       * mid-frame and reads as hung; a static row doesn't promise motion.
       */
      readonly spinning?: boolean;
    },
  ) => Effect.Effect<void>;
  succeed: (message?: string) => Effect.Effect<void>;
  fail: (message?: string) => Effect.Effect<void>;
  close: Effect.Effect<void>;
}

/**
 * What a provider's lifecycle operation gets to report progress on its
 * resource: each note is an `apply.resource.note` event.
 */
export interface ScopedPlanStatusSession {
  note: (note: string, options?: { readonly kind?: NoteKind }) => Effect.Effect<void>;
}

/** The session for one resource: its notes go to `report` as events. */
export const resourceSession = (
  report: (event: ApplyEvent) => Effect.Effect<void>,
  fqn: string,
  id: string,
): ScopedPlanStatusSession => ({
  note: (message, options) =>
    report({ type: "apply.resource.note", fqn, id, message, kind: options?.kind }),
});

/** A session that drops its notes, for calling a provider outside apply. */
export const noopSession: ScopedPlanStatusSession = {
  note: () => Effect.void,
};

export interface PlanDisplayOptions {
  /** Show declared resource inputs as structured YAML. */
  detailed?: boolean;
  /** Stage displayed in terminal lifecycle updates. */
  stage?: string;
  /** Keep the dev plan mounted as a collapsible widget below static logs. */
  dev?: boolean;
}

export interface CLIService {
  startPlanningSession: (
    label: string,
    detail?: string,
    title?: string,
  ) => Effect.Effect<PlanningStatusSession>;
  approvePlan: <P extends Plan>(
    plan: P,
    options?: PlanDisplayOptions,
  ) => Effect.Effect<boolean, NonInteractiveTerminal>;
  displayPlan: <P extends Plan>(plan: P, options?: PlanDisplayOptions) => Effect.Effect<void>;
  startApplySession: <P extends Plan>(
    plan: P,
    options?: PlanDisplayOptions,
  ) => Effect.Effect<PlanStatusSession>;
}

export class Cli extends Context.Service<Cli, CLIService>()("CLI") {}

/**
 * Draw `effect`'s apply events through the ambient {@link Cli} renderer:
 * plan rows, per-resource status and notes, then the outcome. Without a
 * renderer the effect runs as-is; its events are still log records.
 */
export const renderApply =
  (plan: Plan, options?: PlanDisplayOptions) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(
      Effect.serviceOption(Cli),
      Option.match({
        onNone: () => effect,
        onSome: (cli) =>
          Effect.gen(function* () {
            const session = yield* cli.startApplySession(plan, options);
            // Dev keeps the widget mounted after apply settles and parks in the
            // ambient scope; bind the widget's teardown to that scope so a reload
            // or Ctrl+C removes it instead of stacking it under the next one.
            if (options?.dev && session.close !== undefined) {
              const scope = yield* Effect.serviceOption(Scope.Scope);
              if (Option.isSome(scope)) {
                yield* Scope.addFinalizer(scope.value, session.close);
              }
            }
            return yield* effect.pipe(
              onEvent((event) =>
                event.type === "apply.resource.status" || event.type === "apply.resource.note"
                  ? session.emit(event)
                  : Effect.void,
              ),
              Effect.tap((value) =>
                options?.dev && session.setOutput !== undefined
                  ? session.setOutput(value)
                  : Effect.void,
              ),
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? session.done("success")
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? Effect.void
                    : session.done("failure"),
              ),
            );
          }),
      }),
    );
