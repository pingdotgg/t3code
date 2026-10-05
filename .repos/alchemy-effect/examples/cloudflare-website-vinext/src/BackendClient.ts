import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { BackendApi } from "./BackendApi.ts";
import { env } from "./Env.ts";

const backendClient = HttpApiClient.make(BackendApi, {
  baseUrl: "http://localhost",
}).pipe(
  Effect.provide(
    FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, ((input, init) =>
          env.BACKEND.fetch(input, init)) as typeof globalThis.fetch),
      ),
    ),
  ),
);

export class BackendClient extends Context.Service<
  BackendClient,
  Effect.Success<typeof backendClient>
>()("BackendClient") {
  static Default = Layer.effect(BackendClient, backendClient);
}
