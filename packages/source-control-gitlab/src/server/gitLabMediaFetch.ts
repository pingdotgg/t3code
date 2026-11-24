import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import { gitLabMediaUrl, isBlockedGitLabMediaHostname } from "../shared/gitLabMedia.ts";

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const MEDIA_CONTENT_TYPE_PATTERN = /^(?:image|video|audio)\/[\w!#$&^.+-]+$/i;

const contentTypeOf = (response: HttpClientResponse.HttpClientResponse) =>
  response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

export const make = Effect.gen(function* () {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);

  const fetchFollowingRedirects = Effect.fnUntraced(function* (
    url: string,
    headers: Readonly<Record<string, string>>,
  ) {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const response: HttpClientResponse.HttpClientResponse | null = yield* httpClient
        .execute(
          HttpClientRequest.get(target).pipe(
            HttpClientRequest.setHeaders({
              ...headers,
              "accept-encoding": "identity",
            }),
          ),
        )
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
          Effect.orElseSucceed(() => null),
        );
      if (response === null) return null;
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.location;
      if (!location || hop >= MAX_REDIRECTS) return null;
      const next = URL.parse(location, target);
      if (
        next === null ||
        next.protocol !== "https:" ||
        next.username ||
        next.password ||
        isBlockedGitLabMediaHostname(next.hostname)
      ) {
        return null;
      }
      target = next.toString();
    }
  });

  return Effect.fn("GitLabMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const url = URL.parse(request.url);
    if (url === null || gitLabMediaUrl(url) === null) return null;
    const response = yield* fetchFollowingRedirects(request.url, request.headers);
    if (response === null || (response.status !== 200 && response.status !== 206)) return null;
    return MEDIA_CONTENT_TYPE_PATTERN.test(contentTypeOf(response)) ? response : null;
  });
});
