import type { AutomationRule, AutomationRun } from "../shared/schema.ts";
import type * as Effect from "effect/Effect";

export type AutomationRunReason = "manual" | "schedule";

export type PreparedRun =
  | {
      readonly status: "skipped";
      readonly run: AutomationRun;
    }
  | {
      readonly status: "ready";
      readonly rule: AutomationRule;
      readonly queuedRun: AutomationRun;
      readonly release: Effect.Effect<void>;
    };

export type ScheduledRunPreparation = PreparedRun | { readonly status: "idle" };
export type ReadyPreparedRun = Extract<PreparedRun, { readonly status: "ready" }>;
export type RestoreInterruptibility = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;
