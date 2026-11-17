import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import * as ForgejoCli from "./ForgejoCli.ts";

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

/**
 * A repository file's bytes, read with the token this server's `fj` or `tea` login holds.
 * A redirect leaves the server's own origin only when Gitea hands an LFS object to a signed
 * URL, which authorizes on its own and rejects a request that also carries the token.
 */
export const make = Effect.gen(function* () {
  const cli = yield* ForgejoCli.ForgejoCli;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);

  return Effect.fn("ForgejoMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const origin = new URL(request.url).origin;
    const token = yield* cli
      .mediaToken(new URL(request.url).host)
      .pipe(Effect.orElseSucceed(() => null));
    let target = request.url;
    for (let hop = 0; ; hop += 1) {
      const authorization =
        token !== null && new URL(target).origin === origin ? `token ${token}` : null;
      const response: HttpClientResponse.HttpClientResponse = yield* httpClient
        .execute(
          HttpClientRequest.get(target).pipe(
            HttpClientRequest.setHeaders({
              ...request.headers,
              // The bytes are streamed straight through, so never let an encoding layer in.
              "accept-encoding": "identity",
              ...(authorization === null ? {} : { authorization }),
            }),
          ),
        )
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));
      const location = response.headers.location;
      if (response.status < 300 || response.status >= 400) return response;
      if (!location || hop >= MAX_REDIRECTS) return null;
      const next = new URL(location, target);
      if (next.protocol !== "http:" && next.protocol !== "https:") return null;
      target = next.toString();
    }
  });
});
