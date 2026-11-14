import * as Effect from "effect/Effect";

import type * as OpenCode2Server from "./OpenCode2Server.ts";

/**
 * The endpoint OpenCode resolves for every provider, by provider id and by
 * integration id. An empty map means the endpoint is unknown, so a credential
 * is not sent anywhere.
 */
export const readProviderEndpoints = Effect.fn("OpenCode2Client.providerEndpoints")(function* (
  connection: OpenCode2Server.OpenCode2Connection,
  directory: string,
) {
  return yield* Effect.all(
    [
      connection.client.provider.list({ location: { directory } }),
      connection.client.model.list({ location: { directory } }),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([providers, models]) => {
      const endpoints = new Map<string, string>();
      // A provider whose endpoint is unknown, or whose providers disagree, leaves
      // the integration unknown: the probe must not guess which one meters the key.
      const unknown = new Set<string>();
      const record = (key: string, baseURL: string | undefined) => {
        if (unknown.has(key)) return;
        if (baseURL === undefined) {
          endpoints.delete(key);
          unknown.add(key);
          return;
        }
        const known = endpoints.get(key);
        if (known === undefined) {
          endpoints.set(key, baseURL);
          return;
        }
        if (known !== baseURL) {
          endpoints.delete(key);
          unknown.add(key);
        }
      };
      const providerEndpoint = new Map<string, string | undefined>();
      for (const provider of providers.data) {
        providerEndpoint.set(
          provider.id,
          typeof provider.settings?.baseURL === "string" ? provider.settings.baseURL : undefined,
        );
      }
      // A model can resolve to another endpoint on its own, so the provider's
      // endpoint is not the one every model goes to.
      for (const model of models.data) {
        const baseURL =
          typeof model.settings?.baseURL === "string" ? model.settings.baseURL : undefined;
        if (baseURL === undefined) continue;
        const provider = providerEndpoint.get(model.providerID);
        if (provider !== undefined && provider !== baseURL) {
          providerEndpoint.set(model.providerID, undefined);
        }
      }
      for (const provider of providers.data) {
        const baseURL = providerEndpoint.get(provider.id);
        record(provider.id, baseURL);
        if (provider.integrationID !== undefined) record(provider.integrationID, baseURL);
      }
      return endpoints;
    }),
    Effect.catchCause(() => Effect.succeed(new Map<string, string>())),
  );
});
