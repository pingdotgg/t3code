import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import {
  GITHUB_CREDENTIALED_MEDIA_HOSTS,
  gitHubReleaseAsset,
  type GitHubReleaseAsset,
} from "../shared/gitHubMedia.ts";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

/** A private release's bytes download only through the API, by asset id. */
const API_HOST = "api.github.com";

/**
 * Everything a redirect leads to — the presigned object stores GitHub hands assets off to —
 * authorizes with its own signature, and some of them reject a request that also carries a
 * bearer token.
 */
const isCredentialedHost = (url: string) => {
  const target = URL.parse(url);
  return (
    target !== null &&
    target.protocol === "https:" &&
    target.port === "" &&
    (target.hostname.toLowerCase() === API_HOST ||
      GITHUB_CREDENTIALED_MEDIA_HOSTS.has(target.hostname.toLowerCase()))
  );
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

  // Both media hosts are served by github.com's account, which is the host `gh` stores it under.
  // Read on every fetch, so media loads as soon as the user signs in.
  const credential = Effect.suspend(() => credentials.get("github.com")).pipe(
    Effect.orElseSucceed(() => null),
  );

  const fetchFollowingRedirects = Effect.fnUntraced(function* (
    url: string,
    headers: Readonly<Record<string, string>>,
    token: Redacted.Redacted<string> | null,
  ) {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const authorization =
        token !== null && isCredentialedHost(target) ? `Bearer ${Redacted.value(token)}` : null;
      const response: HttpClientResponse.HttpClientResponse = yield* httpClient
        .execute(
          HttpClientRequest.get(target).pipe(
            HttpClientRequest.setHeaders({
              ...headers,
              ...(URL.parse(target)?.hostname === API_HOST
                ? { "x-github-api-version": "2022-11-28", "user-agent": "t3code" }
                : {}),
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

  const fetchReleaseAsset = Effect.fnUntraced(function* (
    release: GitHubReleaseAsset,
    headers: Readonly<Record<string, string>>,
    held: GitHubRequestPolicy.GitHubHeldCredential,
  ) {
    const path = `repos/${encodeURIComponent(release.owner)}/${encodeURIComponent(release.repo)}/releases`;
    // The asset id is only good for the credential that could see the release.
    const metadata = yield* rest
      .rest({
        host: "github.com",
        operation: "getReleaseByTag",
        path: `${path}/tags/${encodeURIComponent(release.tag)}`,
      })
      .pipe(
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
          host: "github.com",
          token: held.token,
          credentialFingerprint: held.fingerprint,
          ...(held.source === undefined ? {} : { source: held.source }),
        }),
      );
    const decoded = yield* decodeRelease(metadata);
    const match = decoded.body.assets.find((candidate) => candidate.name === release.name);
    if (match === undefined) return null;
    return yield* fetchFollowingRedirects(
      `https://${API_HOST}/${path}/assets/${match.id}`,
      { ...headers, accept: "application/octet-stream" },
      held.token,
    );
  });

  return Effect.fn("GitHubMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const target = URL.parse(request.url);
    const release = target === null ? null : gitHubReleaseAsset(target);
    if (release !== null) {
      let held = yield* Effect.option(rest.credential("github.com"));
      while (Option.isSome(held)) {
        const viaApi = yield* fetchReleaseAsset(release, request.headers, held.value).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (viaApi !== null && viaApi.status < 400) return viaApi;
        // The app reaches only repositories it is installed on; the user's own token may see more.
        held =
          held.value.source === "app"
            ? yield* Effect.option(rest.credential("github.com", { personal: true }))
            : Option.none();
      }
      // A public release loads without the token, which a release download never needs.
      return yield* fetchFollowingRedirects(request.url, request.headers, null);
    }
    const signedIn = yield* credential;
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
      const current = yield* credential;
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
