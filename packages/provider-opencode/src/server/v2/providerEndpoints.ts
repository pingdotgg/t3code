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
  return yield* connection.client.provider.list({ location: { directory } }).pipe(
    Effect.map((list) => {
      const endpoints = new Map<string, string>();
      // Two providers that claim one integration with different endpoints leave
      // it unknown: the probe must not guess which one meters the key.
      const conflicting = new Set<string>();
      const record = (key: string, baseURL: string) => {
        if (conflicting.has(key)) return;
        const known = endpoints.get(key);
        if (known === undefined) {
          endpoints.set(key, baseURL);
          return;
        }
        if (known !== baseURL) {
          endpoints.delete(key);
          conflicting.add(key);
        }
      };
      for (const provider of list.data) {
        const baseURL = provider.settings?.baseURL;
        if (typeof baseURL !== "string") continue;
        record(provider.id, baseURL);
        if (provider.integrationID !== undefined) record(provider.integrationID, baseURL);
      }
      return endpoints;
    }),
    Effect.catchCause(() => Effect.succeed(new Map<string, string>())),
  );
});
