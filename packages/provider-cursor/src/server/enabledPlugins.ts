import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { DEFAULT_CURSOR_API_ENDPOINT, exchangeCursorApiKey } from "./apiKey.ts";

const Marketplace = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

const EffectiveUserPlugins = Schema.Struct({
  plugins: Schema.optional(
    Schema.Array(
      Schema.Struct({
        isEnabled: Schema.optional(Schema.Boolean),
        plugin: Schema.optional(
          Schema.Struct({
            name: Schema.optional(Schema.String),
            marketplaceId: Schema.optional(Schema.String),
            marketplace: Schema.optional(Marketplace),
          }),
        ),
      }),
    ),
  ),
  marketplaces: Schema.optional(Schema.Array(Marketplace)),
});

/** The only marketplace whose plugins the Cursor SDK gives to the model. */
export const CURSOR_PUBLIC_MARKETPLACE = "cursor-public";

/** A marketplace or team plugin the Cursor account has enabled. */
export interface CursorEnabledPlugin {
  readonly marketplace: string;
  readonly name: string;
}

export function cursorEnabledPluginsFromResponse(
  response: typeof EffectiveUserPlugins.Type,
): ReadonlyArray<CursorEnabledPlugin> {
  return (response.plugins ?? []).flatMap(({ isEnabled, plugin }) => {
    const name = plugin?.name?.trim();
    const marketplace = (
      plugin?.marketplace ??
      response.marketplaces?.find(
        (candidate) => candidate.id !== undefined && candidate.id === plugin?.marketplaceId,
      )
    )?.name;
    return isEnabled === true && name && marketplace ? [{ marketplace, name }] : [];
  });
}

/** Enablement lives in the Cursor account; the plugin cache on disk also keeps disabled plugins. */
export const readCursorEnabledPlugins = Effect.fn("readCursorEnabledPlugins")(function* (
  apiKey: string,
) {
  const client = yield* HttpClient.HttpClient;
  const token = yield* exchangeCursorApiKey(apiKey);
  const response = yield* client.execute(
    HttpClientRequest.post(
      `${DEFAULT_CURSOR_API_ENDPOINT}/aiserver.v1.DashboardService/GetEffectiveUserPlugins`,
    ).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeader("connect-protocol-version", "1"),
      HttpClientRequest.bodyJsonUnsafe({}),
    ),
  );
  return cursorEnabledPluginsFromResponse(
    yield* HttpClientResponse.schemaBodyJson(EffectiveUserPlugins)(
      yield* HttpClientResponse.filterStatusOk(response),
    ),
  );
}, Effect.timeout("10 seconds"));
