import * as Lambda from "@/AWS/Lambda";
import * as Neon from "@/Neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  backendAuth,
  backendDataApi,
  backendGateway,
} from "./backend-resources.ts";

const bindings = Layer.mergeAll(
  Neon.ConnectAuthHttp,
  Neon.QueryDataApiHttp,
  Neon.QueryAIGatewayHttp,
).pipe(Layer.provide(FetchHttpClient.layer));

export default class BackendHttpLambda extends Lambda.Function<BackendHttpLambda>()(
  "BackendHttpLambda",
  {
    main: import.meta.url,
    functionUrl: true,
  },
  Effect.gen(function* () {
    const auth = yield* Neon.ConnectAuth(backendAuth);
    const data = yield* Neon.QueryDataApi(backendDataApi);
    const ai = yield* Neon.QueryAIGateway(backendGateway);
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          authUrl: yield* auth.baseUrl,
          jwksUrl: yield* auth.jwksUrl,
          dataUrl: yield* data.baseUrl,
          aiUrl: yield* ai.baseUrl,
          hasToken: Redacted.value(yield* ai.token).length > 0,
        });
      }),
    };
  }).pipe(Effect.provide(bindings)),
) {}
