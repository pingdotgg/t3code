import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { clerkPublishableKeyConfig } from "./publicConfig.ts";

export class BrowserAuthError extends Schema.TaggedError<BrowserAuthError>()("BrowserAuthError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Could not contact T3 Connect sign-in.";
  }
}

export class BrowserAuth extends Context.Service<
  BrowserAuth,
  {
    readonly forward: (input: {
      readonly path: string;
      readonly search: string;
      readonly method: "GET" | "POST";
      readonly body?: Uint8Array;
      readonly clientToken?: string;
      readonly contentType?: string;
    }) => Effect.Effect<
      {
        readonly status: number;
        readonly body: string;
        readonly clientToken: string | undefined;
      },
      BrowserAuthError
    >;
  }
>()("t3/cloud/BrowserAuth") {}

const isBrowserAuthError = Schema.is(BrowserAuthError);

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const forward = Effect.fn("cloud.browser_auth.forward")(function* (
    input: Parameters<BrowserAuth["Service"]["forward"]>[0],
  ) {
    const key = yield* clerkPublishableKeyConfig;
    const frontendApi = yield* Effect.try({
      try: () => clerkFrontendApiUrlFromPublishableKey(key),
      catch: (cause) => new BrowserAuthError({ cause }),
    });
    const url = yield* Effect.try({
      try: () => new URL(input.path, frontendApi),
      catch: (cause) => new BrowserAuthError({ cause }),
    });
    // The browser supplies a path, never an upstream host. No environment
    // cookies, pairing credentials, or caller Origin reach Clerk.
    if (url.origin !== frontendApi || !url.pathname.startsWith("/v1/")) {
      return yield* new BrowserAuthError({ cause: "invalid_frontend_api_path" });
    }
    url.search = input.search;
    url.searchParams.set("_is_native", "1");
    let request = HttpClientRequest.make(input.method)(url);
    if (input.clientToken) request = HttpClientRequest.bearerToken(request, input.clientToken);
    if (input.body)
      request = HttpClientRequest.bodyUint8Array(
        request,
        input.body,
        input.contentType ?? "application/x-www-form-urlencoded",
      );
    const response = yield* httpClient.execute(request);
    return {
      status: response.status,
      body: yield* response.text,
      clientToken: response.headers.authorization,
    };
  });
  return BrowserAuth.of({
    forward: Effect.fn("BrowserAuth.forward")((input) =>
      forward(input).pipe(
        Effect.timeout(Duration.seconds(20)),
        Effect.mapError((cause) =>
          isBrowserAuthError(cause) ? cause : new BrowserAuthError({ cause }),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(BrowserAuth, make);
