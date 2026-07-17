import * as Effect from "effect/Effect";
import type * as EffectAcpErrors from "effect-acp/errors";

/**
 * Switch the session model only when the requested id differs from the
 * current one. Drivers differ in how a model switch is written (Grok uses
 * the native session/set_model RPC, Kimi writes the "model" config option),
 * so the setter is injected while the change-detection rule stays shared.
 */
export function applyAcpModelSelectionIfChanged<E>(input: {
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly setModel: (modelId: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel || input.requestedModelId === undefined) {
    return Effect.succeed(input.currentModelId);
  }
  const requestedModelId = input.requestedModelId;
  return input
    .setModel(requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModelId));
}
