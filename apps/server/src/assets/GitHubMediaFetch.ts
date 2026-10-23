import * as Mime from "effect/http/Mime";
import { githubMediaFileName } from "@t3tools/shared/githubMedia";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
  type HttpClientResponse,
} from "effect/http";

import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";

/**
 * Everything a redirect leads to — the presigned object stores GitHub hands assets off to —
 * authorizes with its own signature, and some of them reject a request that also carries a
 * bearer token.
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

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const FORWARDED_REQUEST_HEADERS = ["range", "if-range"] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;
const MEDIA_CONTENT_TYPE_PATTERN = /^(?:image|video|audio)\/[\w!#$&^.+-]+$/i;
const SVG_CONTENT_TYPE = "image/svg+xml";
// An SVG is a document: same policy the asset route gives a workspace SVG, so one embedded in a
// body cannot run script against this origin.
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

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
type MediaCredential = GitHubCredentials.GitHubCredential & {
  readonly operationRepository?: string;
};
const githubToken = (source: string) =>
  !isCredentialedHost(source)
    ? Effect.succeed(null)
    : GitHubCredentials.GitHubCredentials.pipe(
        Effect.flatMap((credentials) =>
          Effect.gen(function* () {
            // Raw/LFS URLs and legacy attachments carry an explicit repository. Modern
            // user-attachments URLs do not, so they keep the host's default credential.
            const repository = repositoryOf(source);
            const credential = yield* credentials.get("github.com", repository ?? undefined);
            const enabled =
              (yield* HostProcess.Environment).T3CODE_GITHUB_USE_GIT_CREDENTIALS === "1";
            // Redirect scope follows the requested repository even on a helper miss. Keep
            // credential.repository as the actual cache provenance for invalidation.
            const operationRepository =
              enabled && repository !== null
                ? GitHubCredentials.normalizeCredentialRepository(repository)!
                : credential.repository;
            return {
              ...credential,
              ...(operationRepository === undefined ? {} : { operationRepository }),
            } satisfies MediaCredential;
          }),
        ),
        Effect.catchIf(
          (error) => error._tag !== "GitHubGitCredentialError",
          () => Effect.succeed(null),
        ),
      );

const fetchFollowingRedirects = Effect.fn("GitHubMediaFetch.fetchFollowingRedirects")(function* (
  url: string,
  headers: Record<string, string>,
  credential: MediaCredential | null,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  let target = url;
  for (let hop = 0; ; hop += 1) {
    const authorization =
      credential !== null &&
      isCredentialedHost(target) &&
      (credential.operationRepository === undefined ||
        GitHubCredentials.normalizeCredentialRepository(repositoryOf(target) ?? "") ===
          credential.operationRepository)
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
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));
    const location = response.headers.location;
    if (response.status < 300 || response.status >= 400) {
      if (
        authorization !== null &&
        credential?.operationRepository !== undefined &&
        (response.status === 401 || response.status === 403)
      ) {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        yield* credentials.invalidate("github.com", credential.repository);
      }
      return response;
    }
    if (!location || hop >= MAX_REDIRECTS) return null;
    const next = new URL(location, target);
    if (next.protocol !== "https:") return null;
    target = next.toString();
  }
});

export const githubMediaResponse = Effect.fn("GitHubMediaFetch.githubMediaResponse")(function* (
  asset: { readonly url: string; readonly cwd: string; readonly expiresAt: number },
  requestHeaders: Record<string, string | undefined>,
) {
  // Both media hosts are served by github.com's account, which is the host `gh` stores it under.
  const credential = yield* githubToken(asset.url);
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = requestHeaders[name];
    if (value !== undefined) forwarded[name] = value;
  }
  const response = yield* fetchFollowingRedirects(asset.url, forwarded, credential);
  const remainingSeconds = Math.floor((asset.expiresAt - (yield* Clock.currentTimeMillis)) / 1000);
  const headers: Record<string, string> = {
    "cache-control":
      remainingSeconds > 0 ? `private, max-age=${remainingSeconds}` : "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (response === null) return HttpServerResponse.empty({ status: 502, headers });
  // It carries none of the upstream entity headers: a `content-length` with no body behind it
  // holds the connection open until the browser gives up on it.
  if (response.status >= 400) {
    return HttpServerResponse.empty({
      status: response.status >= 500 ? 502 : response.status,
      headers,
    });
  }
  const upstreamType =
    response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const contentType = MEDIA_CONTENT_TYPE_PATTERN.test(upstreamType)
    ? upstreamType
    : Option.getOrElse(Mime.getType(githubMediaFileName(asset.url)), () => "").toLowerCase();
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
