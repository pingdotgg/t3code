import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as GitLabCli from "./GitLabCli.ts";

const TOKEN_TTL = Duration.minutes(5);
const MISSING_TOKEN_TTL = Duration.seconds(10);
const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

/**
 * Fetches an upload as the account `glab` is signed in to for its host. A host with no account
 * gets no request at all, so a body cannot point the server at an arbitrary address.
 */
export const make = Effect.gen(function* () {
  const cli = yield* GitLabCli.GitLabCli;
  const cwd = yield* HostProcess.WorkingDirectory;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);

  // `glab` resolves GITLAB_TOKEN and its own config here, and prints nothing for a host it has
  // no account on.
  const tokens = yield* Cache.makeWith(
    (host: string) =>
      cli.execute({ cwd, args: ["config", "get", "token", "--host", host] }).pipe(
        Effect.map((output) => output.stdout.trim() || null),
        Effect.orElseSucceed(() => null),
      ),
    {
      capacity: 16,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? TOKEN_TTL : MISSING_TOKEN_TTL,
    },
  );

  const get = Effect.fn("GitLabMediaFetch.get")(function* (
    request: SourceControlMediaRequest,
    token: string,
  ) {
    const origin = new URL(request.url).origin;
    let target = request.url;
    for (let hop = 0; ; hop += 1) {
      // Object storage a redirect hands off to authorizes by its own signature.
      const sameOrigin = new URL(target).origin === origin;
      const response: HttpClientResponse.HttpClientResponse = yield* httpClient
        .execute(
          HttpClientRequest.get(target).pipe(
            HttpClientRequest.setHeaders({
              ...request.headers,
              // The bytes are streamed straight through, so never let an encoding layer in.
              "accept-encoding": "identity",
              ...(sameOrigin ? { authorization: `Bearer ${token}` } : {}),
            }),
          ),
        )
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));
      const location = response.headers.location;
      if (response.status < 300 || response.status >= 400) return response;
      if (!location || hop >= MAX_REDIRECTS) return null;
      const next = new URL(location, target);
      if (next.protocol !== "https:") return null;
      target = next.toString();
    }
  });

  return Effect.fn("GitLabMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const host = new URL(request.url).host;
    const token = yield* Cache.get(tokens, host);
    if (token === null) return null;
    const response = yield* get(request, token);
    if (response?.status !== 401) return response;
    // An OAuth login's token lasts two hours, and `glab` refreshes it only on a call of its own.
    yield* cli.execute({ cwd, host, args: ["api", "user"] }).pipe(Effect.ignore);
    yield* Cache.invalidate(tokens, host);
    const refreshed = yield* Cache.get(tokens, host);
    return refreshed === null || refreshed === token ? response : yield* get(request, refreshed);
  });
});
