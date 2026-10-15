import * as Mime from "effect/http/Mime";
import { pullRequestMediaFileName } from "@t3tools/shared/pullRequestMedia";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
  type HttpClientResponse,
} from "effect/http";

import * as BitbucketApi from "@t3tools/source-control-bitbucket/server/BitbucketApi";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";

/**
 * Exactly the hosts the GitHub credential is for. Everything a redirect leads to — the presigned
 * object stores GitHub hands assets off to — authorizes with its own signature, and some of
 * them reject a request that also carries a bearer token.
 */
const CREDENTIALED_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "media.githubusercontent.com",
]);
const isCredentialedHost = (url: string) => {
  try {
    return CREDENTIALED_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

/** The host answers a media request with a 302 to a signed object URL that needs no credential. */
const MAX_REDIRECTS = 3;
/** Following the redirect here, rather than in `fetch`, is what keeps the token on its host. */
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
/** Passed through so a seek in a long video costs one upstream range request, not a full download. */
const FORWARDED_REQUEST_HEADERS = ["range", "if-range"] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;
/** A pull request embeds pictures and recordings. Anything else is not served from our origin. */
const MEDIA_CONTENT_TYPE_PATTERN = /^(?:image|video|audio)\/[\w!#$&^.+-]+$/i;
const SVG_CONTENT_TYPE = "image/svg+xml";
// An SVG is a document: same policy the asset route gives a workspace SVG, so one embedded in a
// body cannot run script against this origin.
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * The github.com credential, or null without one: a public asset still loads, and a private one
 * fails the way it does in a browser that is not signed in.
 */
const githubToken = GitHubCredentials.GitHubCredentials.pipe(
  Effect.flatMap((credentials) => credentials.get("github.com")),
  Effect.map((credential) => credential.token),
  Effect.orElseSucceed(() => null),
);

/** Adds the host's credential to a request bound for that host, and leaves any other as it is. */
type Authorize = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientRequest.HttpClientRequest>;

/**
 * Follows the host's redirect to the signed object itself, and never carries the credential off
 * the host: the object URL authorizes with its own signature, and the store it lives in has no
 * business seeing a token.
 */
const fetchFollowingRedirects = Effect.fn("PullRequestMediaFetch.fetchFollowingRedirects")(
  function* (url: string, headers: Record<string, string>, authorize: Authorize) {
    const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
    let target = url;
    for (let hop = 0; ; hop += 1) {
      // `authorize` decides from the target, not from the hop count, so a redirect to a signed
      // object URL goes out without the credential.
      const request = yield* authorize(
        HttpClientRequest.get(target).pipe(
          HttpClientRequest.setHeaders({
            ...headers,
            // The bytes are streamed straight through, so never let an encoding layer in.
            "accept-encoding": "identity",
          }),
        ),
      );
      const response: HttpClientResponse.HttpClientResponse = yield* httpClient
        .execute(request)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));
      const location = response.headers.location;
      if (response.status < 300 || response.status >= 400) return response;
      // A chain this long is not the host answering with bytes, and its body is not the media.
      if (!location || hop >= MAX_REDIRECTS) return null;
      const next = new URL(location, target);
      if (next.protocol !== "https:") return null;
      target = next.toString();
    }
  },
);

/** Streams the media at `asset.url` back to the client, fetched with `authorize`'s credential. */
const mediaResponse = Effect.fn("PullRequestMediaFetch.mediaResponse")(function* (
  asset: { readonly url: string; readonly expiresAt: number },
  requestHeaders: Record<string, string | undefined>,
  authorize: Authorize,
) {
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = requestHeaders[name];
    if (value !== undefined) forwarded[name] = value;
  }
  const response = yield* fetchFollowingRedirects(asset.url, forwarded, authorize);
  // An upload the host serves never changes under its URL, so the only thing a cached copy must
  // not outlive is the signed URL that granted it — which is the same bound the URL itself has.
  const remainingSeconds = Math.floor((asset.expiresAt - (yield* Clock.currentTimeMillis)) / 1000);
  const headers: Record<string, string> = {
    "cache-control":
      remainingSeconds > 0 ? `private, max-age=${remainingSeconds}` : "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (response === null) return HttpServerResponse.empty({ status: 502, headers });
  // An upstream refusal is the client's answer, not this server's fault; only a broken hop is.
  // It carries none of the upstream entity headers: a `content-length` with no body behind it
  // holds the connection open until the browser gives up on it.
  if (response.status >= 400) {
    return HttpServerResponse.empty({
      status: response.status >= 500 ? 502 : response.status,
      headers,
    });
  }
  // Only pictures and recordings leave this origin, and never on the host's word alone: GitHub's
  // raw host labels every committed binary `application/octet-stream`, so the name decides those.
  const upstreamType =
    response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const contentType = MEDIA_CONTENT_TYPE_PATTERN.test(upstreamType)
    ? upstreamType
    : Option.getOrElse(Mime.getType(pullRequestMediaFileName(asset.url)), () => "").toLowerCase();
  if (!MEDIA_CONTENT_TYPE_PATTERN.test(contentType)) {
    return HttpServerResponse.empty({ status: 415, headers });
  }
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  headers["content-type"] = contentType;
  if (contentType === SVG_CONTENT_TYPE) {
    headers["content-security-policy"] = SVG_CONTENT_SECURITY_POLICY;
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    contentType,
  });
});

/**
 * Serves media a pull request body points at on GitHub through the `gh` credential, which is the
 * only thing that distinguishes a readable private attachment from a 404.
 */
export const githubMediaResponse = Effect.fn("PullRequestMediaFetch.githubMediaResponse")(
  function* (
    asset: { readonly url: string; readonly expiresAt: number },
    requestHeaders: Record<string, string | undefined>,
  ) {
    // Both media hosts are served by github.com's account, which is the host `gh` stores it under.
    const token = yield* githubToken;
    return yield* mediaResponse(asset, requestHeaders, (request) =>
      Effect.succeed(
        token !== null && isCredentialedHost(request.url)
          ? request.pipe(HttpClientRequest.bearerToken(Redacted.value(token)))
          : request,
      ),
    );
  },
);

/**
 * Serves a file a pull request body links from a Bitbucket repository's Downloads through the
 * API, the one Bitbucket host that honours the configured credential for it.
 */
export const bitbucketMediaResponse = Effect.fn("PullRequestMediaFetch.bitbucketMediaResponse")(
  function* (
    asset: { readonly url: string; readonly expiresAt: number },
    requestHeaders: Record<string, string | undefined>,
  ) {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    return yield* mediaResponse(asset, requestHeaders, bitbucket.authorize);
  },
);

/** Serves pull request media through the credential of the host it was signed for. */
export const pullRequestMediaResponse = Effect.fn("PullRequestMediaFetch.pullRequestMediaResponse")(
  function* (
    asset: {
      readonly kind: "github-media" | "bitbucket-media";
      readonly url: string;
      readonly expiresAt: number;
    },
    requestHeaders: Record<string, string | undefined>,
  ) {
    return asset.kind === "github-media"
      ? yield* githubMediaResponse(asset, requestHeaders)
      : yield* bitbucketMediaResponse(asset, requestHeaders);
  },
);
