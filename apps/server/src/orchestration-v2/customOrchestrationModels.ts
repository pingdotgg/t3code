import type { ModelSelection, ProjectId, ServerSettings } from "@t3tools/contracts";
import {
  customOrchestrationModelProblem,
  type CustomOrchestrationModelProblem,
} from "@t3tools/shared/customOrchestration";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";

export type CustomOrchestrationAvailability = (
  selection: ModelSelection,
) => CustomOrchestrationModelProblem | null;

/** Judges configured models by live provider state; without a registry every model counts as usable. */
export const customOrchestrationAvailability = Effect.fn("customOrchestration.availability")(
  function* (
    registry: Option.Option<ProviderRegistry.ProviderRegistry["Service"]>,
    settings: ServerSettings,
    projectId: ProjectId | null,
  ): Effect.fn.Return<CustomOrchestrationAvailability> {
    if (Option.isNone(registry)) return () => null;
    const providers = yield* registry.value.getProviders;
    const now = yield* Clock.currentTimeMillis;
    return (selection) =>
      customOrchestrationModelProblem(selection, { providers, now, settings, projectId });
  },
);

/** What a turn on `running` needs to write its Custom Orchestration prompt. */
export const customOrchestrationTurn = Effect.fn("customOrchestration.turn")(function* (
  registry: Option.Option<ProviderRegistry.ProviderRegistry["Service"]>,
  settings: ServerSettings,
  projectId: ProjectId,
  running: ModelSelection,
) {
  const problemOf = yield* customOrchestrationAvailability(registry, settings, projectId);
  return { settings: settings.customOrchestration, turn: { running, problemOf } };
});

export function describeCustomOrchestrationProblem(
  problem: CustomOrchestrationModelProblem,
): string {
  switch (problem.kind) {
    case "provider":
      return "its provider is unavailable";
    case "model":
      return "its provider does not offer it";
    case "limit":
      return problem.resetsAt === null
        ? "it is at its usage limit"
        : `it is at its usage limit until ${problem.resetsAt}`;
  }
}
