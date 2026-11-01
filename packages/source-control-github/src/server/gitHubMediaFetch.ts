import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import { GITHUB_CREDENTIALED_MEDIA_HOSTS, gitHubReleaseAsset } from "../shared/gitHubMedia.ts";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";

/** A private release's bytes download only through the API, by asset id. */
const API_HOST = "api.github.com";

/**
 * Everything a redirect leads to — the presigned object stores GitHub hands assets off to —
 * authorizes with its own signature, and some of them reject a request that also carries a
 * bearer token.
 */
const isCredentialedHost = (url: string) => {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === API_HOST || GITHUB_CREDENTIALED_MEDIA_HOSTS.has(hostname);
  } catch {
    return false;
  }
};

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

const decodeRelease = Schema.decodeUnknownEffect(
  Schema.Struct({
    truncated: Schema.Literal(false),
    body: Schema.fromJsonString(
      Schema.Struct({
        assets: Schema.Array(
          Schema.Struct({ id: Schema.Int.check(Schema.isGreaterThan(0)), name: Schema.String }),
        ),
      }),
    ),
  }),
);

export const make = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const api = yield* GitHubRest.GitHubRest;

  // Both media hosts are served by github.com's account, which is the host `gh` stores it under.
  // Read on every fetch, so media loads as soon as the user signs in.
  const token = Effect.suspend(() => credentials.get("github.com")).pipe(
    Effect.map((credential) => credential.token),
    Effect.orElseSucceed(() => null),
  );

  const fetchFollowingRedirects = Effect.fn("GitHubMediaFetch.fetchFollowingRedirects")(function* (
    url: string,
    headers: Readonly<Record<string, string>>,
    bearer: Redacted.Redacted<string> | null,
  ) {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const authorization =
        bearer !== null && isCredentialedHost(target) ? `Bearer ${Redacted.value(bearer)}` : null;
      const response: HttpClientResponse.HttpClientResponse = yield* httpClient
        .execute(
          HttpClientRequest.get(target).pipe(
            HttpClientRequest.setHeaders({
              ...headers,
              ...(new URL(target).hostname === API_HOST
                ? { "x-github-api-version": "2022-11-28", "user-agent": "t3code" }
                : {}),
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
      if (next.protocol !== "https:") return null;
      target = next.toString();
    }
  });

  return Effect.fn("GitHubMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const bearer = yield* token;
    const release = gitHubReleaseAsset(new URL(request.url));
    let response: HttpClientResponse.HttpClientResponse | null = null;
    if (release !== null && bearer !== null) {
      response = yield* Effect.gen(function* () {
        const path = `repos/${encodeURIComponent(release.owner)}/${encodeURIComponent(release.repo)}/releases`;
        const metadata = yield* api.rest({
          host: "github.com",
          operation: "getReleaseByTag",
          path: `${path}/tags/${encodeURIComponent(release.tag)}`,
        });
        const decoded = yield* decodeRelease(metadata);
        const match = decoded.body.assets.find((candidate) => candidate.name === release.name);
        if (match === undefined) return null;
        return yield* fetchFollowingRedirects(
          `https://${API_HOST}/${path}/assets/${match.id}`,
          { ...request.headers, accept: "application/octet-stream" },
          bearer,
        );
      }).pipe(Effect.orElseSucceed(() => null));
    }
    // A public release loads without the token, which a release download never needs.
    if (response === null || (release !== null && response.status >= 400)) {
      response = yield* fetchFollowingRedirects(
        request.url,
        request.headers,
        release === null ? bearer : null,
      );
    }
    return response;
  });
});
