import type { OpenCodeClient } from "@opencode/client/effect";
import * as Effect from "effect/Effect";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import type { OpenCode2Catalog } from "./status.ts";

// Cold catalogs take seconds; model reads already retry empty catalogs.
const DECORATION_TIMEOUT = "3 seconds";

const locationOf = (directory: string | undefined) =>
  directory === undefined ? {} : { location: { directory } };

const listProviders = (client: OpenCodeClient, directory: string | undefined) =>
  client.provider.list(locationOf(directory)).pipe(
    Effect.timeout(DECORATION_TIMEOUT),
    Effect.map((list) => list.data),
  );

// Only primary agents can run a thread's turns; subagents are the model's own tools.
const listAgents = (client: OpenCodeClient, directory: string | undefined) =>
  client.agent.list(locationOf(directory)).pipe(
    Effect.timeout(DECORATION_TIMEOUT),
    Effect.map((list) =>
      list.data
        .filter((agent) => !agent.hidden && agent.mode !== "subagent")
        .map((agent) => ({ id: agent.id, name: agent.name })),
    ),
    Effect.orElseSucceed(() => []),
  );

const readCatalog = <E>(
  client: OpenCodeClient,
  directory: string | undefined,
  providers: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string }>, E>,
): Effect.Effect<OpenCode2Catalog, OpenCodeRuntime.OpenCodeRuntimeError> =>
  Effect.all(
    {
      // Callers bound the read: a busy host can hold it past OpenCode's own activation wait.
      models: client.model.list(locationOf(directory)).pipe(Effect.map((list) => list.data)),
      providers,
      agents: listAgents(client, directory),
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(({ models, providers, agents }) => {
      const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
      return {
        models: models.map((model) => {
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
        }),
        agents,
      };
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

/** Provider names and agents are optional decoration; bound their reads so models cannot stall. */
export const loadOpenCode2Catalog = (client: OpenCodeClient, directory: string | undefined) =>
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
