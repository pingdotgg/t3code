import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafeHosts from "./gitCafeHosts.ts";

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

/**
 * Loads an attachment `mediaUrl` claimed with the viewer's token for its host, so a private
 * repository's images reach the client as bytes and the token never leaves the server.
 */
export const make = Effect.gen(function* () {
  const credentials = yield* GitCafeCredentials.GitCafeCredentials;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);

  return Effect.fn("GitCafeMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const { origin, hostname } = new URL(request.url);
    const host = GitCafeHosts.gitCafeHost(hostname);
    // Signed out still loads a public repository's attachments.
    const credential =
      host === null ? null : yield* credentials.get(host).pipe(Effect.orElseSucceed(() => null));
    let target = request.url;
    for (let hop = 0; ; hop += 1) {
      // A redirect off the host goes to storage that authorizes by its own signature.
      const authorization =
        credential !== null && new URL(target).origin === origin
          ? `Bearer ${Redacted.value(credential.token)}`
          : null;
      const response: HttpClientResponse.HttpClientResponse = yield* httpClient
        .execute(
          HttpClientRequest.get(target).pipe(
            HttpClientRequest.setHeaders({
              ...request.headers,
              // The bytes are streamed straight through, so never let an encoding layer in.
              "accept-encoding": "identity",
              "user-agent": "t3code",
              ...(authorization === null ? {} : { authorization }),
            }),
          ),
        )
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));
      if (response.status === 401 && host !== null && authorization !== null) {
        yield* credentials.invalidate(host);
      }
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.location;
      if (!location || hop >= MAX_REDIRECTS) return null;
      const next = new URL(location, target);
      if (next.protocol !== "https:") return null;
      target = next.toString();
    }
  });
});
