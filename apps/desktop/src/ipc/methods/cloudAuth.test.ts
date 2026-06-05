import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { afterEach } from "vitest";

import { fetchCloudAuth, validateClerkFrontendApiUrl } from "./cloudAuth.ts";

const originalClerkPublishableKey = process.env.T3CODE_CLERK_PUBLISHABLE_KEY;

const clerkPublishableKey = (hostname: string): string =>
  `pk_test_${Buffer.from(`${hostname}$`).toString("base64")}`;

function makeHttpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, never>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

describe("Desktop cloud auth IPC", () => {
  afterEach(() => {
    if (originalClerkPublishableKey === undefined) {
      delete process.env.T3CODE_CLERK_PUBLISHABLE_KEY;
    } else {
      process.env.T3CODE_CLERK_PUBLISHABLE_KEY = originalClerkPublishableKey;
    }
  });

  it.effect("preserves Clerk's URL-encoded OAuth form content type", () => {
    const body = "strategy=oauth_google&redirect_url=t3code%3A%2F%2Fauth%2Fcallback";
    let forwardedRequest: HttpClientRequest.HttpClientRequest | null = null;
    const layer = makeHttpClientLayer((request) =>
      Effect.sync(() => {
        forwardedRequest = request;
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ response: { object: "sign_in_attempt" } }),
        );
      }),
    );

    return Effect.gen(function* () {
      yield* fetchCloudAuth.handler({
        url: "https://example.clerk.accounts.dev/v1/client/sign_ins",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "x-mobile": "1",
        },
        body,
      });

      assert(forwardedRequest !== null);
      assert.equal(
        forwardedRequest.headers["content-type"],
        "application/x-www-form-urlencoded;charset=UTF-8",
      );
      assert.equal(forwardedRequest.body._tag, "Uint8Array");
      if (forwardedRequest.body._tag === "Uint8Array") {
        assert.equal(new TextDecoder().decode(forwardedRequest.body.body), body);
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "allows the custom Clerk Frontend API host encoded by the configured publishable key",
    () => {
      process.env.T3CODE_CLERK_PUBLISHABLE_KEY = clerkPublishableKey("clerk.t3.codes");
      let forwardedRequest: HttpClientRequest.HttpClientRequest | null = null;
      const layer = makeHttpClientLayer((request) =>
        Effect.sync(() => {
          forwardedRequest = request;
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ response: { object: "client" } }),
          );
        }),
      );

      return Effect.gen(function* () {
        yield* fetchCloudAuth.handler({
          url: "https://clerk.t3.codes/v1/client",
          method: "GET",
          headers: {},
        });

        assert(forwardedRequest !== null);
        assert.equal(forwardedRequest.url.toString(), "https://clerk.t3.codes/v1/client");
      }).pipe(Effect.provide(layer));
    },
  );

  it("rejects arbitrary HTTPS hosts that are not configured Clerk Frontend API hosts", () => {
    process.env.T3CODE_CLERK_PUBLISHABLE_KEY = clerkPublishableKey("clerk.t3.codes");
    assert.throws(
      () => validateClerkFrontendApiUrl("https://attacker.example/v1/client"),
      /restricted to Clerk Frontend API HTTPS hosts/u,
    );
  });
});
