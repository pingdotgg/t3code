import type { OpenCodeClient } from "@opencode/client/effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import type { OpenCode2Model } from "./status.ts";

// Cold catalogs take seconds; model reads already retry empty catalogs.
const PROVIDER_NAME_TIMEOUT = "3 seconds";

/** Provider names are optional decoration; bound their read so models cannot stall. */
export const loadOpenCode2Catalog = (
  client: OpenCodeClient,
  directory: string,
): Effect.Effect<ReadonlyArray<OpenCode2Model>, OpenCodeRuntime.OpenCodeRuntimeError> => {
  const location = { directory };
  return Effect.all(
    {
      models: client.model.list({ location }),
      providers: client.provider
        .list({ location })
        .pipe(Effect.timeout(PROVIDER_NAME_TIMEOUT), Effect.option),
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(({ models, providers }) => {
      const providerNames = new Map(
        (Option.getOrUndefined(providers)?.data ?? []).map((provider) => [
          provider.id,
          provider.name,
        ]),
      );
      return models.data.map((model) => {
        const providerName = providerNames.get(model.providerID);
        return {
          providerID: model.providerID,
          id: model.id,
          name: model.name,
          ...(providerName ? { providerName } : {}),
          variants: model.variants.map((variant) => ({ id: variant.id })),
          family: model.family,
          released: model.time.released,
          deprecated: model.status === "deprecated",
        };
      });
    }),
    Effect.mapError(
      (cause) =>
        new OpenCodeRuntime.OpenCodeRuntimeError({
          operation: "model.list",
          detail: "The OpenCode server could not list its models.",
          cause,
        }),
    ),
  );
};
