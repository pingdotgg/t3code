import * as Effect from "effect/Effect";
import { isPullRequestMediaRedirectAllowed } from "@t3tools/shared/pullRequestMedia";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import type { ResolvedAsset } from "./AssetAccess.ts";
import { mediaResponse } from "./GitHubMediaFetch.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";

export const pullRequestMediaResponse = Effect.fn("PullRequestMediaFetch.response")(function* (
  asset: Extract<ResolvedAsset, { readonly kind: "pull-request-media" }>,
  requestHeaders: Readonly<Record<string, string | undefined>>,
) {
  const headers: Record<string, string> = { "accept-encoding": "identity" };
  for (const name of ["range", "if-range"]) {
    const value = requestHeaders[name];
    if (value !== undefined) headers[name] = value;
  }
  const service = yield* PullRequestService.PullRequestService;
  let response: HttpClientResponse.HttpClientResponse | null = yield* service.readAttachment({
    ...asset.reference,
    provider: asset.provider,
    url: asset.url,
    headers,
  });
  const originalOrigin = new URL(response.request.url).origin;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  for (let hop = 0; response.status >= 300 && response.status < 400; hop++) {
    const location = response.headers.location;
    if (!location || hop >= 3) {
      response = null;
      break;
    }
    const next = URL.parse(location, response.request.url);
    if (next === null || !isPullRequestMediaRedirectAllowed(asset.provider, originalOrigin, next)) {
      response = null;
      break;
    }
    response = yield* httpClient
      .execute(HttpClientRequest.get(next.href).pipe(HttpClientRequest.setHeaders(headers)))
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  }
  return yield* mediaResponse(asset, response);
});
