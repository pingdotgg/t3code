import { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolvePrimaryEnvironmentHttpUrl } from "./target";

export class PrimaryEnvironmentHttpClient extends Context.Service<
  PrimaryEnvironmentHttpClient,
  Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>
>()("@t3tools/web/environments/primary/httpClient/PrimaryEnvironmentHttpClient") {}

const make = Effect.suspend(() =>
  makeEnvironmentHttpApiClient(resolvePrimaryEnvironmentHttpUrl("/")),
);

export const layer = Layer.effect(PrimaryEnvironmentHttpClient, make);
