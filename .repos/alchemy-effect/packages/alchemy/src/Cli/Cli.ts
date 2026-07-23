import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Plan } from "../Plan.ts";
import type { ApplyEvent } from "./Event.ts";

export interface PlanStatusSession {
  emit: (event: ApplyEvent) => Effect.Effect<void>;
  done: () => Effect.Effect<void>;
}

export interface ScopedPlanStatusSession extends PlanStatusSession {
  note: (note: string) => Effect.Effect<void>;
}

export interface CLIService {
  approvePlan: <P extends Plan>(plan: P) => Effect.Effect<boolean>;
  displayPlan: <P extends Plan>(plan: P) => Effect.Effect<void>;
  startApplySession: <P extends Plan>(
    plan: P,
  ) => Effect.Effect<PlanStatusSession>;
}

export class Cli extends Context.Service<Cli, CLIService>()("CLI") {}
