import * as Cloudflare from "@/Cloudflare";
import * as Neon from "@/Neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  backendAuth,
  backendBranch,
  backendDataApi,
  backendGateway,
} from "./backend-resources.ts";

const bindings = Layer.mergeAll(
  Neon.ConnectAuthHttp,
  Neon.QueryDataApiHttp,
  Neon.QueryAIGatewayHttp,
).pipe(Layer.provide(FetchHttpClient.layer));

export default class BackendHttpWorker extends Cloudflare.Worker<BackendHttpWorker>()(
  "BackendHttpWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const auth = yield* Neon.ConnectAuth(backendAuth);
    const data = yield* Neon.QueryDataApi(backendDataApi);
    const ai = yield* Neon.QueryAIGateway(backendGateway);
    const shared = yield* Neon.QueryAIGateway(
      Effect.gen(function* () {
        return yield* Neon.AIGateway("SharedGateway", {
          branch: yield* backendBranch,
        });
      }),
    );
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          authUrl: yield* auth.baseUrl,
          jwksUrl: yield* auth.jwksUrl,
          dataUrl: yield* data.baseUrl,
          aiUrl: yield* ai.baseUrl,
          hasToken: Redacted.value(yield* ai.token).length > 0,
          sharedToken:
            Redacted.value(yield* ai.token) ===
            Redacted.value(yield* shared.token),
        });
      }),
    };
  }).pipe(Effect.provide(bindings)),
) {}
