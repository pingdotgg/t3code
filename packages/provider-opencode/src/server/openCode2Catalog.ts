import type { OpenCodeClient } from "@opencode/client/effect";
import * as Effect from "effect/Effect";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import type { OpenCode2Model } from "./status.ts";

// Cold catalogs take seconds; model reads already retry empty catalogs.
const PROVIDER_NAME_TIMEOUT = "3 seconds";

const listProviders = (client: OpenCodeClient, directory: string) =>
  client.provider.list({ location: { directory } }).pipe(
    Effect.timeout(PROVIDER_NAME_TIMEOUT),
    Effect.map((list) => list.data),
  );

const readCatalog = <E>(
  client: OpenCodeClient,
  directory: string,
  providers: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string }>, E>,
): Effect.Effect<ReadonlyArray<OpenCode2Model>, OpenCodeRuntime.OpenCodeRuntimeError> =>
  Effect.all(
    { models: client.model.list({ location: { directory } }), providers },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(({ models, providers }) => {
      const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
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

/** Provider names are optional decoration; bound their read so models cannot stall. */
export const loadOpenCode2Catalog = (client: OpenCodeClient, directory: string) =>
  readCatalog(
    client,
    directory,
    listProviders(client, directory).pipe(Effect.orElseSucceed(() => [])),
  );

/** Missing provider names would relabel every model, so a directory read needs them. */
export const loadOpenCode2DirectoryCatalog = Effect.fn(
  "OpenCodeRuntime.loadOpenCode2DirectoryCatalog",
)((client: OpenCodeClient, directory: string) =>
  readCatalog(client, directory, listProviders(client, directory)),
);
