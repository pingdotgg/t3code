import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as GitHubRest from "./GitHubRest.ts";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import { GITHUB_CREDENTIALED_MEDIA_HOSTS } from "../shared/gitHubMedia.ts";

import * as GitHubCredentials from "./GitHubCredentials.ts";

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

function githubMarkdownRepository(repositoryUrl: string): string | null {
  const match = /^https:\/\/github\.com\/([\w-]+)\/([\w.-]+)\/?$/u.exec(repositoryUrl);
  return match && match[2] !== "." && match[2] !== ".." ? `${match[1]}/${match[2]}` : null;
}

function signedMediaSource(html: string): string | null {
  const image = /<img\b[^>]*>/i.exec(html)?.[0];
  const source = image && /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(image);
  const attribute = source?.[1] ?? source?.[2];
  if (!attribute) return null;
  const entities: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  const decoded = attribute.replace(
    /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi,
    (entity, name: string) => {
      if (!name.startsWith("#")) return entities[name.toLowerCase()] ?? entity;
      const code =
        name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    },
  );
  try {
    const url = new URL(decoded);
    return url.protocol === "https:" &&
      url.hostname === "private-user-images.githubusercontent.com" &&
      url.username === "" &&
      url.password === "" &&
      url.port === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const resolveAttachment = Effect.fn("GitHubMediaFetch.resolveAttachment")(function* (
  url: string,
  context: string,
) {
  const github = yield* GitHubRest.GitHubRest;
  const rendered = yield* github.rest({
    host: "github.com",
    operation: "resolve pull request attachment",
    method: "POST",
    path: "markdown",
    body: { mode: "gfm", text: `![](<${url}>)`, context },
    maxResponseBytes: 64 * 1024,
  });
  return rendered.truncated || rendered.invalidUtf8 ? null : signedMediaSource(rendered.body);
});

export const make = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);

  // Both media hosts are served by github.com's account, which is the host `gh` stores it under.
  // Read on every fetch, so media loads as soon as the user signs in.
  const token = Effect.suspend(() => credentials.get("github.com")).pipe(
    Effect.map((credential) => credential.token),
    Effect.orElseSucceed(() => null),
  );

  const github = yield* GitHubRest.GitHubRest;
  const fetch = Effect.fn("GitHubMediaFetch.fetchFollowingRedirects")(function* (
    url: string,
    headers: Readonly<Record<string, string>>,
    bearer: Redacted.Redacted | null,
  ) {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const authorization =
        bearer !== null && isCredentialedHost(target) ? `Bearer ${Redacted.value(bearer)}` : null;
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
      const release = Scope.close(scope, Exit.void);
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
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
          Effect.provideService(Scope.Scope, scope),
        );
      const location = response.headers.location;
      if (response.status < 300 || response.status >= 400) return { response, release };
      yield* release;
      if (!location || hop >= MAX_REDIRECTS) return null;
      const next = new URL(location, target);
      if (next.protocol !== "https:") return null;
      target = next.toString();
    }
  });
  return Effect.fn("GitHubMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const bearer = yield* token;
    let fetched = yield* fetch(request.url, request.headers, bearer);
    const context =
      request.repositoryUrl === undefined ? null : githubMarkdownRepository(request.repositoryUrl);
    const url = new URL(request.url);
    const attachment =
      url.hostname === "github.com" &&
      (/^\/user-attachments\/assets\/[\w-]+$/.test(url.pathname) ||
        /^\/[^/]+\/[^/]+\/assets\/\d+\/[\w-]+$/.test(url.pathname));
    if (
      fetched &&
      context &&
      attachment &&
      ([401, 403, 404].includes(fetched.response.status) ||
        (fetched.response.status >= 200 &&
          fetched.response.status < 300 &&
          /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
            fetched.response.headers["content-type"] ?? "",
          )))
    ) {
      yield* fetched.release;
      const signed = yield* resolveAttachment(request.url, context).pipe(
        Effect.provideService(GitHubRest.GitHubRest, github),
        Effect.orElseSucceed(() => null),
      );
      fetched =
        signed === null
          ? null
          : yield* fetch(signed, request.headers, null).pipe(Effect.orElseSucceed(() => null));
    }
    return fetched?.response ?? null;
  });
});
