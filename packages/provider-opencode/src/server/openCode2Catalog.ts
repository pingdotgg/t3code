import type { OpenCodeClient } from "@opencode/client/effect";
import * as Effect from "effect/Effect";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { chatGptWorkspaceScope } from "./chatGptWorkspaceScope.ts";
import { openCodePrice, type OpenCode2Model } from "./status.ts";

// Cold catalogs take seconds; model reads already retry empty catalogs.
const PROVIDER_NAME_TIMEOUT = "3 seconds";

function usesChatGptEndpoint(providerID: string, baseURL: unknown) {
  if (baseURL === undefined) return providerID === "openai";
  if (typeof baseURL !== "string" || !URL.canParse(baseURL)) return false;
  const { origin, pathname } = new URL(baseURL);
  // OpenCode's ChatGPT plugin rewrites the standard OpenAI origin to the Codex backend.
  return (
    (providerID === "openai" && origin === "https://api.openai.com") ||
    (origin === "https://chatgpt.com" && /^\/backend-api\/codex(?:\/|$)/.test(pathname))
  );
}

const workspaceHeader = (headers: Readonly<Record<string, string>> | undefined) =>
  Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "chatgpt-account-id")?.[1];

const locationOf = (directory: string | undefined) =>
  directory === undefined ? {} : { location: { directory } };

const listProviders = (client: OpenCodeClient, directory: string | undefined) =>
  client.provider.list(locationOf(directory)).pipe(
    Effect.timeout(PROVIDER_NAME_TIMEOUT),
    Effect.map((list) => list.data),
  );

const readCatalog = <E>(
  client: OpenCodeClient,
  directory: string | undefined,
  providers: Effect.Effect<
    ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly integrationID?: string | undefined;
      readonly activation?: string;
      readonly headers?: Readonly<Record<string, string>> | undefined;
      readonly settings?: Readonly<Record<string, unknown>> | undefined;
    }>,
    E
  >,
): Effect.Effect<ReadonlyArray<OpenCode2Model>, OpenCodeRuntime.OpenCodeRuntimeError> =>
  Effect.all(
    {
      // Callers bound the read: a busy host can hold it past OpenCode's own activation wait.
      models: client.model.list(locationOf(directory)).pipe(Effect.map((list) => list.data)),
      providers,
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(({ models, providers }) => {
      const routes = new Map(providers.map((provider) => [provider.id, provider]));
      return models.map((model) => {
        const route = routes.get(model.providerID);
        const providerName = route?.name;
        const baseCost = model.cost.find((cost) => cost.tier === undefined);
        const endpoint = model.settings?.baseURL ?? route?.settings?.baseURL;
        const workspace = workspaceHeader(model.headers) ?? workspaceHeader(route?.headers);
        return {
          providerID: model.providerID,
          id: model.id,
          name: model.name,
          ...(providerName ? { providerName } : {}),
          ...(route &&
          route.activation !== "disabled" &&
          (route.integrationID ?? route.id) === "openai" &&
          usesChatGptEndpoint(model.providerID, endpoint) &&
          model.variants.every(
            (variant) =>
              usesChatGptEndpoint(model.providerID, variant.settings?.baseURL ?? endpoint) &&
              (workspaceHeader(variant.headers) ?? workspace) === workspace,
          )
            ? { usageScope: workspace === undefined ? "openai" : chatGptWorkspaceScope(workspace) }
            : {}),
          variants: model.variants.map((variant) => ({ id: variant.id })),
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
