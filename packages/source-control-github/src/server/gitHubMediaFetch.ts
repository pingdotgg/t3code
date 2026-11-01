import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import { GITHUB_CREDENTIALED_MEDIA_HOSTS } from "../shared/gitHubMedia.ts";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";
import { makeResolveRepository } from "./GitHubSourceControlProvider.ts";

/**
 * Everything a redirect leads to — the presigned object stores GitHub hands assets off to —
 * authorizes with its own signature, and some of them reject a request that also carries a
 * bearer token.
 */
const isCredentialedHost = (url: string) => {
  try {
    return GITHUB_CREDENTIALED_MEDIA_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const SIGNED_MEDIA_SOURCE =
  /\ssrc="(https:\/\/private-user-images\.githubusercontent\.com\/[^"]+)"/u;
// GitHub's signed media links expire 300 seconds after signing.
const SIGNED_URL_TTL = Duration.minutes(4);

export const make = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const api = yield* GitHubRest.GitHubRest;
  const resolveRepository = yield* makeResolveRepository;

  // Both media hosts are served by github.com's account, which is the host `gh` stores it under.
  // Read on every fetch, so media loads as soon as the user signs in.
  const token = Effect.suspend(() => credentials.get("github.com")).pipe(
    Effect.map((credential) => credential.token),
    Effect.orElseSucceed(() => null),
  );

  // github.com ignores a token's SAML SSO grant, so an SSO org answers its sign-in page. The API
  // honours the grant, and renders attachments as links that load with no credential.
  const signedUrls = yield* Cache.makeWith(
    Effect.fn("GitHubMediaFetch.signAttachment")(function* (attachment: {
      readonly url: string;
      readonly cwd: string;
    }) {
      const repository = yield* resolveRepository({ cwd: attachment.cwd, host: "github.com" });
      const rendered = yield* api.rest({
        host: repository.host,
        operation: "renderMarkdown",
        method: "POST",
        path: "markdown",
        body: {
          text: `![](${attachment.url})`,
          mode: "gfm",
          context: `${repository.owner}/${repository.name}`,
        },
      });
      return SIGNED_MEDIA_SOURCE.exec(rendered.body)?.[1]?.replaceAll("&amp;", "&") ?? null;
    }),
    {
      capacity: 256,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? SIGNED_URL_TTL : Duration.zero,
    },
  );

  return Effect.fn("GitHubMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const bearer = yield* token;
    const signed = request.url.startsWith("https://github.com/")
      ? yield* Cache.get(signedUrls, { url: request.url, cwd: request.cwd }).pipe(
          Effect.orElseSucceed(() => null),
        )
      : null;
    let target = signed ?? request.url;
    for (let hop = 0; ; hop += 1) {
      const authorization =
        bearer !== null && isCredentialedHost(target) ? `Bearer ${Redacted.value(bearer)}` : null;
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
      if (next.protocol !== "https:") return null;
      target = next.toString();
    }
  });
});
