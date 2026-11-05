import {
  WS_METHODS,
  type ModelEvaluationGuidance,
  type ModelSelection,
  type ServerProvider,
  type ModelEvaluationListInput,
  type ModelEvaluationClearInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  getInitialServerConfig,
  request,
  requestGuarded,
  EnvironmentRpcUnavailableError,
} from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "../state/runtime.ts";

const requireCapability = Effect.fn("ModelEvaluations.requireCapability")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const config = yield* getInitialServerConfig().pipe(
    Effect.mapError((error) =>
      error._tag === "EnvironmentRpcUnavailableError"
        ? error
        : new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: `Could not read model evaluation settings on ${supervisor.target.label}: ${error.detail}`,
          }),
    ),
  );
  if (config.environment.capabilities.modelEvaluations !== true) {
    return yield* new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message: "Update this server to use model evaluations.",
    });
  }
});

export function createModelEvaluationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "model-evaluations:list",
    tag: WS_METHODS.modelEvaluationsList,
    staleTimeMs: 0,
    execute: Effect.fn("ModelEvaluations.list")(function* (
      input: typeof ModelEvaluationListInput.Type,
    ) {
      yield* requireCapability();
      return yield* request(WS_METHODS.modelEvaluationsList, input);
    }),
  });
  return {
    list,
    clear: createEnvironmentRpcCommand(runtime, {
      label: "model-evaluations:clear",
      tag: WS_METHODS.modelEvaluationsClear,
      execute: Effect.fn("ModelEvaluations.clear")(function* (
        input: typeof ModelEvaluationClearInput.Type,
      ) {
        yield* requireCapability();
        return yield* requestGuarded(WS_METHODS.modelEvaluationsClear, input);
      }),
      onSuccess: (target, registry) => Effect.sync(() => registry.refresh(list(target))),
    }),
  };
}

export function isModelEvaluationJudge(provider: ServerProvider): boolean {
  return (
    provider.supportsTextGeneration !== false &&
    provider.textGenerationOperations?.includes("generateModelEvaluation") === true
  );
}

export function modelEvaluationSelectionLabel(selection: ModelSelection): string {
  const options = selection.options?.map((option) => `${option.id}: ${option.value}`).join(", ");
  return `${selection.model} (${selection.instanceId})${options ? ` · ${options}` : ""}`;
}

const SCORE_LABELS = {
  taskCompletion: "Task completion",
  correctness: "Correctness",
  instructionFollowing: "Instruction following",
  verification: "Verification",
} as const;

export function modelEvaluationScoreRows(guidance: ModelEvaluationGuidance) {
  return Object.entries(SCORE_LABELS).map(([key, label]) => {
    const dimension = key as keyof typeof SCORE_LABELS;
    const score = guidance.meanScores[dimension];
    return {
      key,
      label,
      value: score === null ? "Not established" : `${score.toFixed(1)} / 4`,
      count: guidance.scoreCounts[dimension],
    };
  });
}

export function modelEvaluationGuidanceKey(guidance: ModelEvaluationGuidance): string {
  return JSON.stringify([
    guidance.modelSelection,
    guidance.evaluatorSelection,
    guidance.rubricVersion,
    guidance.taskCategory,
    guidance.scope,
  ]);
}
