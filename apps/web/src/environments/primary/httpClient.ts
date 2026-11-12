import type { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime/rpc";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import { resolvePrimaryEnvironmentHttpUrl } from "./target";

type PrimaryEnvironmentHttpApiClient = Effect.Success<
  ReturnType<typeof makeEnvironmentHttpApiClient>
>;

export interface PrimaryEnvironmentHttpClient {
  readonly PrimaryEnvironmentHttpClient: unique symbol;
}

export const PrimaryEnvironmentHttpClient: Context.Service<
  PrimaryEnvironmentHttpClient,
  PrimaryEnvironmentHttpApiClient
> = Context.Service("@t3tools/web/environments/primary/httpClient/PrimaryEnvironmentHttpClient");

// Resolve the base per request, after the desktop bearer wait: the desktop can move its
// backend to another port before it is ready, and the old port may belong to another server.
const make = HttpApiClient.make(EnvironmentHttpApi, {
  transformClient: HttpClient.mapRequest((request) =>
    HttpClientRequest.prependUrl(request, resolvePrimaryEnvironmentHttpUrl("/")),
  ),
});

export const layer = Layer.effect(PrimaryEnvironmentHttpClient, make);
