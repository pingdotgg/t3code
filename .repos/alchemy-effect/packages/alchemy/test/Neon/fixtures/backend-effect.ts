import * as Neon from "@/Neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
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

export default class BackendEffect extends Neon.Function<BackendEffect>()(
  "BackendEffect",
  Effect.gen(function* () {
    return { branch: yield* backendBranch, main: import.meta.url };
  }),
  Effect.gen(function* () {
    const auth = yield* Neon.ConnectAuth(backendAuth);
    const data = yield* Neon.QueryDataApi(backendDataApi);
    const ai = yield* Neon.QueryAIGateway(backendGateway);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.url === "/data-invalid-token") {
          const response = yield* data.execute(
            HttpClientRequest.get(""),
            Redacted.make("invalid-end-user-token"),
          );
          return HttpServerResponse.text(String(response.status));
        }
        if (request.url === "/data-foreign-origin") {
          const rejected = yield* data
            .execute(
              HttpClientRequest.get("https://example.com/"),
              Redacted.make("invalid-end-user-token"),
            )
            .pipe(
              Effect.as(false),
              Effect.catchTag("DataApiRequestError", () =>
                Effect.succeed(true),
              ),
            );
          return yield* HttpServerResponse.json({ rejected });
        }
        return yield* HttpServerResponse.json({
          authUrl: yield* auth.baseUrl,
          jwksUrl: yield* auth.jwksUrl,
          dataUrl: yield* data.baseUrl,
          aiUrl: yield* ai.baseUrl,
          chatUrl: yield* ai.chatBaseUrl,
          responsesUrl: yield* ai.responsesBaseUrl,
          hasToken: Redacted.value(yield* ai.token).length > 0,
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(bindings)),
) {}
