import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";

import { fetchCloudAuth, validateClerkFrontendApiUrl } from "./cloudAuth.ts";

const originalClerkPublishableKey = process.env.T3CODE_CLERK_PUBLISHABLE_KEY;
const originalFetch = globalThis.fetch;

const clerkPublishableKey = (hostname: string): string =>
  `pk_test_${Buffer.from(`${hostname}$`).toString("base64")}`;

type FetchCall = readonly [input: RequestInfo | URL, init: RequestInit];

const recordedFetch = (...responses: ReadonlyArray<Response>) => {
  const calls: Array<FetchCall> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    if (!response) {
      return Promise.reject(new Error("Unexpected fetch call"));
    }
    return Promise.resolve(response);
  }) satisfies typeof fetch;

  return { fetchFn, calls };
};

describe("Desktop cloud auth IPC", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalClerkPublishableKey === undefined) {
      delete process.env.T3CODE_CLERK_PUBLISHABLE_KEY;
    } else {
      process.env.T3CODE_CLERK_PUBLISHABLE_KEY = originalClerkPublishableKey;
    }
  });

  it.effect("preserves Clerk's URL-encoded OAuth form content type", () => {
    const body = "strategy=oauth_google&redirect_url=t3code%3A%2F%2Fauth%2Fcallback";
    const fetch = recordedFetch(Response.json({ response: { object: "sign_in_attempt" } }));
    globalThis.fetch = fetch.fetchFn;

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

      const forwardedRequest = fetch.calls[0];
      assert(forwardedRequest !== undefined);
      const [url, init] = forwardedRequest;
      assert.equal(String(url), "https://example.clerk.accounts.dev/v1/client/sign_ins");
      assert.equal(init.method, "POST");
      assert.equal(
        new Headers(init.headers).get("content-type"),
        "application/x-www-form-urlencoded;charset=UTF-8",
      );
      assert.equal(new TextDecoder().decode(init.body as Uint8Array), body);
    });
  });

  it.effect(
    "allows the custom Clerk Frontend API host encoded by the configured publishable key",
    () => {
      process.env.T3CODE_CLERK_PUBLISHABLE_KEY = clerkPublishableKey("clerk.t3.codes");
      const fetch = recordedFetch(Response.json({ response: { object: "client" } }));
      globalThis.fetch = fetch.fetchFn;

      return Effect.gen(function* () {
        yield* fetchCloudAuth.handler({
          url: "https://clerk.t3.codes/v1/client",
          method: "GET",
          headers: {},
        });

        const forwardedRequest = fetch.calls[0];
        assert(forwardedRequest !== undefined);
        assert.equal(String(forwardedRequest[0]), "https://clerk.t3.codes/v1/client");
      });
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
