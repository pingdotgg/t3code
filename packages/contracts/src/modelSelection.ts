import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { keepCloudRunOptions, ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Selection of a model on a configured provider instance.
 *
 * `instanceId` is the routing key. The provider driver, credentials,
 * environment, and continuation identity are resolved by the provider
 * instance registry rather than encoded into the selection itself.
 */
const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

/**
 * The decoder still accepts the historical `{ provider, model }` shape while
 * V1 persistence remains readable. Runtime code only receives the canonical
 * instance-based representation.
 */
export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformEffect({
      decode: (raw) => {
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          instanceId: value.instanceId,
          model: value.model,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

/**
 * Carries a thread's cloud choice into a new model or option selection. Where
 * a thread runs is fixed once it starts, so editors that rebuild options from
 * model traits must not drop it.
 */
export function keepCloudRun(
  next: ModelSelection,
  current: ModelSelection | null | undefined,
): ModelSelection {
  const options = keepCloudRunOptions(next.options, current?.options);
  if (options === next.options) return next;
  return {
    ...next,
    ...(options ? { options } : {}),
  };
}
