import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
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

/**
 * Everything a redirect leads to — the presigned object stores GitHub hands assets off to —
 * authorizes with its own signature, and some of them reject a request that also carries a
 * bearer token.
 */
const isCredentialedHost = (url: string, hosts: ReadonlySet<string>) => {
  const target = URL.parse(url);
  return (
    target !== null &&
    target.protocol === "https:" &&
    target.username === "" &&
    target.password === "" &&
    hosts.has(target.host.toLowerCase())
  );
};

/**
 * The account a request authenticates as, and the hosts its token may be sent to. An Enterprise
 * Server host's token goes only to that host and its `raw.` subdomain, never to github.com.
 */
const credentialScope = (request: SourceControlMediaRequest) => {
  const enterpriseHost = request.host?.trim().toLowerCase();
  if (enterpriseHost && !GITHUB_CREDENTIALED_MEDIA_HOSTS.has(enterpriseHost)) {
    const hosts: ReadonlySet<string> = new Set([enterpriseHost, `raw.${enterpriseHost}`]);
    if (isCredentialedHost(request.url, hosts)) {
      return { account: enterpriseHost, hosts, enterprise: true };
    }
  }
  return { account: "github.com", hosts: GITHUB_CREDENTIALED_MEDIA_HOSTS, enterprise: false };
};

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const MEDIA_CONTENT_TYPE_PATTERN = /^(?:image|video|audio)\/[\w!#$&^.+-]+$/i;
const ATTACHMENT_PATH_PATTERN =
  /^\/(?:user-attachments\/assets\/[\w-]+|[^/]+\/[^/]+\/assets\/\d+\/[\w-]+)$/u;
const LEGACY_ATTACHMENT_REPOSITORY_PATTERN = /^\/([^/]+\/[^/]+)\/assets\//u;
const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/u;
// GitHub's signed upload links last about five minutes.
const SIGNED_URL_CACHE_TTL_MS = 4 * 60_000;
const SIGNED_URL_CACHE_MAX_ENTRIES = 64;

const contentTypeOf = (response: HttpClientResponse.HttpClientResponse) =>
  response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

/** The repository an upload has to be rendered in, or `undefined` when it is not an upload. */
const uploadRepository = (request: SourceControlMediaRequest) => {
  const target = URL.parse(request.url);
  if (
    target === null ||
    target.protocol !== "https:" ||
    target.hostname !== "github.com" ||
    target.port !== "" ||
    target.username !== "" ||
    target.password !== "" ||
    !ATTACHMENT_PATH_PATTERN.test(target.pathname)
  ) {
    return undefined;
  }
  // A legacy upload names its repository; one the caller supplies cannot override that.
  const repository =
    LEGACY_ATTACHMENT_REPOSITORY_PATTERN.exec(target.pathname)?.[1] ?? request.repository;
  // An unusable explicit context must not fall back to an unrelated checkout.
  return repository !== undefined && REPOSITORY_PATTERN.test(repository) ? repository : undefined;
};

export const make = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const rest = yield* GitHubRest.GitHubRest;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const signedUrls = new Map<string, { readonly at: number; readonly url: string }>();

  // github.com's media hosts are served by github.com's account, which is the host `gh` stores it
  // under. Read on every fetch, so media loads as soon as the user signs in.
  const credential = (account: string) =>
    Effect.suspend(() => credentials.get(account)).pipe(Effect.orElseSucceed(() => null));

  const fetchFollowingRedirects = Effect.fnUntraced(function* (
    url: string,
    headers: Readonly<Record<string, string>>,
    token: Redacted.Redacted<string> | null,
    credentialedHosts: ReadonlySet<string> = GITHUB_CREDENTIALED_MEDIA_HOSTS,
  ) {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const authorization =
        token !== null && isCredentialedHost(target, credentialedHosts)
          ? `Bearer ${Redacted.value(token)}`
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
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
          // A signed URL's query string is a bearer capability; keep it out of tracing spans.
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        );
      const location = response.headers.location;
      if (response.status < 300 || response.status >= 400) return response;
      if (!location || hop >= MAX_REDIRECTS) return null;
      const next = URL.parse(location, target);
      if (next === null || next.protocol !== "https:" || next.username || next.password) {
        return null;
      }
      target = next.toString();
    }
  });

  // An organization with SAML SSO answers a token-authenticated upload request with its sign-in
  // page. Rendering the link as markdown in the repository's context hands back a signed URL.
  const renderSignedUrl = Effect.fnUntraced(function* (url: string, repository: string) {
    const rendered = yield* rest
      .rest({
        host: "github.com",
        operation: "renderMarkdown",
        method: "POST",
        path: "markdown",
        accept: "text/html",
        body: { text: `![](${url})`, mode: "gfm", context: repository },
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (rendered === null || rendered.status !== 200 || rendered.truncated) return null;
    for (const match of rendered.body.matchAll(/<img\b[^>]*\ssrc\s*=\s*(["'])(.*?)\1/giu)) {
      const signed = URL.parse(match[2]?.replaceAll("&amp;", "&") ?? "");
      if (
        signed?.protocol === "https:" &&
        signed.hostname === "private-user-images.githubusercontent.com" &&
        signed.port === "" &&
        signed.username === "" &&
        signed.password === "" &&
        signed.searchParams.get("jwt")
      ) {
        return signed.toString();
      }
    }
    return null;
  });

  return Effect.fn("GitHubMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const scope = credentialScope(request);
    const signedIn = yield* credential(scope.account);
    // The client names an Enterprise host, so only one the user has signed in to is fetched.
    if (scope.enterprise && signedIn === null) return null;
    const repository = signedIn === null ? undefined : uploadRepository(request);
    const cacheKey =
      signedIn === null || repository === undefined
        ? null
        : [signedIn.fingerprint, repository, request.url].map(encodeURIComponent).join("|");
    const now = yield* Clock.currentTimeMillis;
    const cached = cacheKey === null ? undefined : signedUrls.get(cacheKey);
    let response: HttpClientResponse.HttpClientResponse | null;
    if (cacheKey !== null && cached !== undefined && now - cached.at < SIGNED_URL_CACHE_TTL_MS) {
      response = yield* fetchFollowingRedirects(cached.url, request.headers, null);
      if (response === null || response.status >= 400) signedUrls.delete(cacheKey);
      // A signed URL can expire before its TTL; only then is a fresh one worth rendering.
      if (response?.status !== 403) return response;
    } else {
      if (cacheKey !== null) signedUrls.delete(cacheKey);
      response = yield* fetchFollowingRedirects(
        request.url,
        request.headers,
        signedIn?.token ?? null,
        scope.hosts,
      );
      if (response === null || contentTypeOf(response) !== "text/html") return response;
    }
    if (cacheKey === null || repository === undefined || signedIn === null) return response;
    const signed = yield* renderSignedUrl(request.url, repository);
    if (signed === null) return response;
    const media = yield* fetchFollowingRedirects(signed, request.headers, null);
    if (
      (media?.status === 200 || media?.status === 206) &&
      MEDIA_CONTENT_TYPE_PATTERN.test(contentTypeOf(media))
    ) {
      // The render can run under another account if the user switched mid-request.
      const current = yield* credential(scope.account);
      if (current?.fingerprint === signedIn.fingerprint) {
        if (signedUrls.size >= SIGNED_URL_CACHE_MAX_ENTRIES) {
          const oldest = signedUrls.keys().next().value;
          if (oldest !== undefined) signedUrls.delete(oldest);
        }
        signedUrls.set(cacheKey, { at: now, url: signed });
      }
    }
    return media;
  });
});
