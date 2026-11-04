import * as UrlParams from "effect/http/UrlParams";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as BrowserAuth from "./BrowserAuth.ts";

function setup() {
  const requests: Array<{
    url: string;
    authorization: string | undefined;
    cookie: string | undefined;
    origin: string | undefined;
    body: string;
  }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({
        url:
          new URL(request.url).origin +
          new URL(request.url).pathname +
          "?" +
          UrlParams.toString(request.urlParams),
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        origin: request.headers.origin,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ response: { id: "client-1" } }), {
          headers: {
            "content-type": "application/json",
            authorization: "Bearer native-client-jwt",
            "set-cookie": "upstream-cookie=not-forwarded",
          },
        }),
      );
    }),
  );
  const layer = BrowserAuth.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));
  const config = ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
      },
    }),
  );
  const provide = <A, E>(effect: Effect.Effect<A, E, BrowserAuth.BrowserAuth>) =>
    effect.pipe(Effect.provide(Layer.mergeAll(layer, config)));
  return { requests, provide };
}

describe("native browser Clerk transport", () => {
  it.effect("uses the configured native Frontend API and returns the client JWT", () => {
    const test = setup();
    return test.provide(
      Effect.gen(function* () {
        const auth = yield* BrowserAuth.BrowserAuth;
        const response = yield* auth.forward({
          path: "/v1/client",
          search: "?test=1",
          method: "GET",
        });
        assert.strictEqual(response.clientToken, "Bearer native-client-jwt");
        assert.strictEqual(response.status, 200);
        const url = new URL(test.requests[0]!.url);
        assert.strictEqual(url.origin, "https://clerk.example.test");
        assert.strictEqual(url.pathname, "/v1/client");
        assert.strictEqual(url.searchParams.get("_is_native"), "1");
        assert.strictEqual(url.searchParams.get("test"), "1");
        assert.isUndefined(test.requests[0]?.origin);
        assert.isUndefined(test.requests[0]?.cookie);
      }),
    );
  });
  it.effect(
    "uses the browser's client JWT and preserves the SDK's form body and method override",
    () => {
      const test = setup();
      return test.provide(
        Effect.gen(function* () {
          const auth = yield* BrowserAuth.BrowserAuth;
          yield* auth.forward({
            path: "/v1/client/sign_ins",
            search: "?_method=PATCH&_is_native=0",
            method: "POST",
            clientToken: "client-1",
            body: new TextEncoder().encode("strategy=email_code&code=123456"),
          });
          assert.strictEqual(test.requests[0]?.authorization, "Bearer client-1");
          assert.strictEqual(test.requests[0]?.body, "strategy=email_code&code=123456");
          const url = new URL(test.requests[0]!.url);
          assert.strictEqual(url.searchParams.get("_method"), "PATCH");
          assert.strictEqual(url.searchParams.get("_is_native"), "1");
        }),
      );
    },
  );
  it.effect("rejects caller-selected hosts and paths outside the Frontend API", () => {
    const test = setup();
    return test.provide(
      Effect.gen(function* () {
        const auth = yield* BrowserAuth.BrowserAuth;
        for (const path of [
          "https://other.test/v1/client",
          "//other.test/v1/client",
          "/v1/../../oauth/token",
          "/oauth/token",
        ]) {
          const error = yield* auth
            .forward({ path, search: "", method: "GET", clientToken: "private" })
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "BrowserAuthError");
        }
        assert.deepStrictEqual(test.requests, []);
      }),
    );
  });
});
