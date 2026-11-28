import type { OpenCodeClient } from "@opencode/client/effect";
import * as Effect from "effect/Effect";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { openCodePrice, type OpenCode2Model } from "./status.ts";

// Cold catalogs take seconds; model reads already retry empty catalogs.
const PROVIDER_NAME_TIMEOUT = "3 seconds";

const locationOf = (directory: string | undefined) =>
  directory === undefined ? {} : { location: { directory } };

const listProviders = (client: OpenCodeClient, directory: string | undefined) =>
  client.provider.list(locationOf(directory)).pipe(
    Effect.timeout(PROVIDER_NAME_TIMEOUT),
    Effect.map((list) => list.data),
  );

// Optional like provider names: without them models fall back to OpenCode's built-in agents.
const listPrimaryAgents = (client: OpenCodeClient, directory: string | undefined) =>
  client.agent.list(locationOf(directory)).pipe(
    Effect.timeout(PROVIDER_NAME_TIMEOUT),
    Effect.map((list) =>
      list.data
        .filter((agent) => !agent.hidden && agent.mode !== "subagent")
        .map((agent): string => agent.id),
    ),
    Effect.orElseSucceed(() => undefined),
  );

const readCatalog = <E>(
  client: OpenCodeClient,
  directory: string | undefined,
  providers: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string }>, E>,
): Effect.Effect<ReadonlyArray<OpenCode2Model>, OpenCodeRuntime.OpenCodeRuntimeError> =>
  Effect.all(
    {
      // Callers bound the read: a busy host can hold it past OpenCode's own activation wait.
      models: client.model.list(locationOf(directory)).pipe(Effect.map((list) => list.data)),
      providers,
      agents: listPrimaryAgents(client, directory),
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(({ models, providers, agents }) => {
      const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
      return models.map((model) => {
        const providerName = providerNames.get(model.providerID);
        const baseCost = model.cost.find((cost) => cost.tier === undefined);
        return {
          providerID: model.providerID,
          id: model.id,
          name: model.name,
          ...(providerName ? { providerName } : {}),
          variants: model.variants.map((variant) => ({ id: variant.id })),
          ...(agents ? { agents } : {}),
          family: model.family,
          released: model.time.released,
          deprecated: model.status === "deprecated",
          ...(baseCost ? { price: openCodePrice(baseCost) } : {}),
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
export const loadOpenCode2Catalog = (client: OpenCodeClient, directory: string | undefined) =>
  readCatalog(
    client,
    directory,
    listProviders(client, directory).pipe(Effect.orElseSucceed(() => [])),
  );

/** Missing provider names would relabel every model, so a read nothing settles needs them. */
export const loadOpenCode2DirectoryCatalog = Effect.fn(
  "OpenCodeRuntime.loadOpenCode2DirectoryCatalog",
)((client: OpenCodeClient, directory: string | undefined) =>
  readCatalog(client, directory, listProviders(client, directory)),
);
