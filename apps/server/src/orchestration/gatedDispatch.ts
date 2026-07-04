import { type OrchestrationCommand, OrchestrationDispatchCommandError } from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ServerRuntimeStartupShape } from "../serverRuntimeStartup.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export const toOrchestrationDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
  isOrchestrationDispatchCommandError(cause)
    ? cause
    : new OrchestrationDispatchCommandError({
        message: cause instanceof Error ? cause.message : fallbackMessage,
        cause,
      });

export const dispatchThroughStartupGate = (
  command: OrchestrationCommand,
  orchestrationEngine: OrchestrationEngineShape,
  startup: ServerRuntimeStartupShape,
): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
  const dispatchEffect = orchestrationEngine
    .dispatch(command)
    .pipe(
      Effect.mapError((cause) =>
        toOrchestrationDispatchCommandError(cause, "Failed to dispatch orchestration command"),
      ),
    );

  return startup
    .enqueueCommand(dispatchEffect)
    .pipe(
      Effect.mapError((cause) =>
        toOrchestrationDispatchCommandError(cause, "Failed to dispatch orchestration command"),
      ),
    );
};
