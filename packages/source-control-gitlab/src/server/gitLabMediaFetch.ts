import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { gitLabMediaUrl } from "../shared/gitLabMedia.ts";

const MEDIA_CONTENT_TYPE_PATTERN = /^(?:image|video|audio)\/[\w!#$&^.+-]+$/i;

const contentTypeOf = (response: HttpClientResponse.HttpClientResponse) =>
  response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

export const make = Effect.gen(function* () {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);

  return Effect.fn("GitLabMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const url = URL.parse(request.url);
    if (request.host === undefined || url === null || gitLabMediaUrl(url, request.host) === null) {
      return null;
    }
    // No token: UploadsController ignores PAT, and a Private-Token would ride a redirect to object storage.
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(request.url).pipe(
          HttpClientRequest.setHeaders({
            ...request.headers,
            "accept-encoding": "identity",
          }),
        ),
      )
      .pipe(Effect.orElseSucceed(() => null));
    if (response === null || (response.status !== 200 && response.status !== 206)) return null;
    return MEDIA_CONTENT_TYPE_PATTERN.test(contentTypeOf(response)) ? response : null;
  });
});
