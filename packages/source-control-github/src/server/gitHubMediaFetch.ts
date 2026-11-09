import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import { GITHUB_CREDENTIALED_MEDIA_HOSTS } from "../shared/gitHubMedia.ts";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";

/** Redirected object stores authorize with their own signature, never a GitHub bearer. */
const isCredentialedHost = (url: string) => {
  const target = URL.parse(url);
  return (
    target !== null &&
    target.protocol === "https:" &&
    target.port === "" &&
    GITHUB_CREDENTIALED_MEDIA_HOSTS.has(target.hostname.toLowerCase())
  );
};

const repositoryOf = (source: string) => {
  const url = new URL(source);
  const parts = url.pathname.split("/");
  if (url.hostname.toLowerCase() === "media.githubusercontent.com") {
    if (parts[1] !== "media") return null;
    parts.splice(1, 1);
  }
  const repository = `${parts[1]}/${parts[2]}`;
  return isCredentialedHost(source) &&
    parts.length > 3 &&
    parts[1] !== "user-attachments" &&
    GitHubCredentials.normalizeCredentialRepository(repository) !== null
    ? repository
    : null;
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
  const enabled = (yield* HostProcess.Environment).T3CODE_GITHUB_USE_GIT_CREDENTIALS === "1";
  const signedUrls = new Map<string, { readonly at: number; readonly url: string }>();

  const credentialFor = (request: SourceControlMediaRequest) =>
    isCredentialedHost(request.url)
      ? credentials
          .get(
            "github.com",
            repositoryOf(request.url) ?? (enabled ? uploadRepository(request) : undefined),
          )
          .pipe(
            Effect.catchIf(
              (error) => error._tag !== "GitHubGitCredentialError",
              () => Effect.succeed(null),
            ),
            // The generic media driver exposes HTTP failures; retain helper failure as its cause.
            Effect.mapError(
              (cause) =>
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request: HttpClientRequest.get(request.url),
                    description: "GitHub media credential lookup failed.",
                    cause,
                  }),
                }),
            ),
          )
      : Effect.succeed(null);

  const fetchFollowingRedirects = Effect.fnUntraced(function* (
    url: string,
    headers: Readonly<Record<string, string>>,
    credential: GitHubCredentials.GitHubCredential | null,
    operationRepository?: string,
  ) {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const authorization =
        credential !== null &&
        isCredentialedHost(target) &&
        (operationRepository === undefined ||
          target === url ||
          GitHubCredentials.normalizeCredentialRepository(repositoryOf(target) ?? "") ===
            operationRepository)
          ? `Bearer ${Redacted.value(credential.token)}`
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
      if (response.status < 300 || response.status >= 400) {
        if (
          authorization !== null &&
          operationRepository !== undefined &&
          (response.status === 401 || response.status === 403)
        ) {
          yield* credentials.invalidate("github.com", credential?.repository);
        }
        return response;
      }
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
  const renderSignedUrl = Effect.fnUntraced(function* (
    url: string,
    repository: string,
    credential: GitHubCredentials.GitHubCredential,
  ) {
    const render = rest.rest({
      host: "github.com",
      repository,
      operation: "renderMarkdown",
      method: "POST",
      path: "markdown",
      accept: "text/html",
      body: { text: `![](${url})`, mode: "gfm", context: repository },
    });
    const rendered = yield* (
      enabled
        ? render.pipe(
            Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
              host: "github.com",
              token: credential.token,
              credentialFingerprint: credential.fingerprint,
              source: credential.source,
              repository: GitHubCredentials.normalizeCredentialRepository(repository)!,
              ...(credential.repository === undefined
                ? {}
                : { credentialRepository: credential.repository }),
            }),
          )
        : render
    ).pipe(Effect.orElseSucceed(() => null));
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
    const signedIn = yield* credentialFor(request);
    const requestedRepository = repositoryOf(request.url) ?? uploadRepository(request);
    // Redirect scope and credential-cache provenance remain independent after a helper miss.
    const operationRepository =
      enabled && requestedRepository !== undefined
        ? GitHubCredentials.normalizeCredentialRepository(requestedRepository)!
        : signedIn?.repository;
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
        signedIn,
        operationRepository,
      );
      if (response === null || contentTypeOf(response) !== "text/html") return response;
    }
    if (cacheKey === null || repository === undefined || signedIn === null) return response;
    const signed = yield* renderSignedUrl(request.url, repository, signedIn);
    if (signed === null) return response;
    const media = yield* fetchFollowingRedirects(signed, request.headers, null);
    if (
      (media?.status === 200 || media?.status === 206) &&
      MEDIA_CONTENT_TYPE_PATTERN.test(contentTypeOf(media))
    ) {
      // The render can run under another account if the user switched mid-request.
      const current = yield* credentialFor(request);
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
