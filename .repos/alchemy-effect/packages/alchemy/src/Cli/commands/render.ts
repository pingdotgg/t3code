import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Alchemist from "../../Alchemist/index.ts";
import type { Event, PlanningPhase } from "../../Events.ts";
import { Interaction } from "../../Interaction.ts";
import * as Report from "../../Report.ts";
import { isPromptCancellation } from "./errors.ts";

export const renderPlanning =
  (options: { operation: string; stage: string; computingLabel?: string; readyLabel?: string }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const phaseLabel: Record<PlanningPhase, string> = {
        "importing-module": "Importing stack module",
        "resolving-services": "Resolving stack services",
        "loading-state": "Loading stack state",
        "computing-plan": options.computingLabel ?? "Computing plan",
        "plan-ready": options.readyLabel ?? "Plan ready",
      };
      const cli = yield* Report.Cli;
      const planning = yield* cli.startPlanningSession(
        phaseLabel["importing-module"],
        options.stage,
        `${options.operation} · ${options.stage}`,
      );
      const interactive = (yield* Interaction).terminal.input;
      const inFlight = new Set<string>();
      let done = 0;
      let total = 0;
      const showCounter = (fallback: string) =>
        Effect.suspend(() => {
          const current: string = inFlight.values().next().value ?? fallback;
          const rest = inFlight.size > 1 ? ` +${inFlight.size - 1}` : "";
          return planning.update(
            phaseLabel["computing-plan"],
            `${done}/${total} · ${current}${rest}`,
          );
        });
      const completed = (event: { fqn: string; completed: number; total: number }) => {
        if (!interactive) return Effect.void;
        inFlight.delete(event.fqn);
        done = event.completed;
        total = event.total;
        return showCounter(event.fqn);
      };
      return yield* effect.pipe(
        Alchemist.onEvent(
          Match.type<Event>().pipe(
            Match.discriminators("type")({
              "plan.phase": (event) =>
                event.phase === "plan-ready"
                  ? planning.succeed(phaseLabel["plan-ready"])
                  : planning.update(phaseLabel[event.phase], options.stage, {
                      spinning: event.phase !== "importing-module",
                    }),
              "state.bootstrap.started": (event) =>
                planning.update(`Bootstrapping state store '${event.store}'`, options.stage),
              "state.bootstrap.completed": () =>
                planning.update(phaseLabel["loading-state"], options.stage),
              "plan.resource.started": (event) => {
                if (!interactive) return Effect.void;
                inFlight.add(event.fqn);
                total = Math.max(total, event.total);
                return showCounter(event.fqn);
              },
              "plan.resource.completed": completed,
              "plan.action.completed": completed,
            }),
            Match.orElse(() => Effect.void),
          ),
        ),
        // A prompt dismissed mid-plan (e.g. a provider asking the user to
        // resolve an ambiguity) is a cancellation, not a planning failure.
        Effect.tapError((error) =>
          planning.fail(isPromptCancellation(error) ? "Planning was canceled" : "Planning failed"),
        ),
        Effect.ensuring(planning.close),
      );
    });
