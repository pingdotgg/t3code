import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import { gitLabUploadApiUrl, parseGitLabUpload } from "../shared/gitLabMedia.ts";

import * as GitLabCredentials from "./GitLabCredentials.ts";

const PUBLIC_HOST = "gitlab.com";
const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

export const make = Effect.gen(function* () {
  const credentials = yield* GitLabCredentials.GitLabCredentials;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);

  /** Follows redirects by hand so `authorization` reaches only `origin`, not object storage. */
  const fetchFollowingRedirects = Effect.fnUntraced(function* (
    url: string,
    headers: Readonly<Record<string, string>>,
    credential: { readonly origin: string; readonly authorization: string } | null,
  ) {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const authorization =
        credential !== null && new URL(target).origin === credential.origin
          ? credential.authorization
          : null;
      const response: HttpClientResponse.HttpClientResponse = yield* httpClient
        .execute(
          HttpClientRequest.get(target).pipe(
            HttpClientRequest.setHeaders({
              ...headers,
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

  /**
   * Reads the upload through the API with the `glab` login for its host. Where the API refuses it
   * (GitLab before 17.4), or gitlab.com without a login, the upload itself serves a public project.
   */
  return Effect.fn("GitLabMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const url = new URL(request.url);
    const upload = parseGitLabUpload(url);
    if (upload === null) return null;
    const token = yield* credentials.get(url.host);
    // Anyone can write the URL into a body, so only a host `glab` is signed in to, or the public
    // GitLab, is ever asked.
    if (Option.isNone(token) && url.host !== PUBLIC_HOST) return null;
    if (Option.isSome(token)) {
      const response = yield* fetchFollowingRedirects(gitLabUploadApiUrl(upload), request.headers, {
        origin: upload.origin,
        authorization: `Bearer ${Redacted.value(token.value)}`,
      });
      if (response !== null && response.status < 400) return response;
      if (response?.status === 401) yield* credentials.invalidate(url.host);
    }
    return yield* fetchFollowingRedirects(request.url, request.headers, null);
  });
});
