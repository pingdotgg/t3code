import { issueHostKey, IssueTrackerKind, type IssueRef } from "@t3tools/contracts";
import * as IssueTrackerHost from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Mime from "effect/http/Mime";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
  type HttpClientResponse,
} from "effect/http";

import * as IssueService from "../issue/IssueService.ts";
import * as IssueTrackerHostLive from "../issue/IssueTrackerHostLive.ts";

const LINEAR = IssueTrackerKind.make("linear");
const MEDIA_CONTENT_TYPE_PATTERN = /^(?:image|video|audio)\/[\w!#$&^.+-]+$/i;
const FORWARDED_RESPONSE_HEADERS = [
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;

export function linearMediaFetchUrl(source: string): string | null {
  const url = URL.parse(source);
  if (
    url === null ||
    source.length > 2048 ||
    url.protocol !== "https:" ||
    url.hostname !== "uploads.linear.app" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    return null;
  url.hash = "";
  return url.href;
}

export const linearMediaSourceAvailable = Effect.fn("LinearMediaFetch.sourceAvailable")(function* (
  issue: IssueRef,
) {
  if (issue.tracker !== LINEAR || issueHostKey(issue.host ?? "linear.app") !== "linear.app")
    return false;
  const issues = yield* IssueService.IssueService;
  return yield* issues.sources(issue.projectId).pipe(
    Effect.map((sources) =>
      sources.some(
        (source) =>
          source.tracker === LINEAR &&
          issueHostKey(source.host) === "linear.app" &&
          source.connectionId === issue.connectionId &&
          (!source.scope.includes("/") ||
            (issue.scope.includes("/") &&
              source.scope.split("/")[0]?.toLowerCase() ===
                issue.scope.split("/")[0]?.toLowerCase())),
      ),
    ),
    Effect.orElseSucceed(() => false),
  );
});

const fetchMedia = Effect.fn("LinearMediaFetch.fetchMedia")(function* (
  url: string,
  headers: Record<string, string>,
  token: string,
) {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  let target = url;
  for (let hop = 0; ; hop += 1) {
    const authorization = linearMediaFetchUrl(target) === null ? {} : { authorization: token };
    const result = yield* http
      .execute(
        HttpClientRequest.get(target).pipe(
          HttpClientRequest.setHeaders({
            ...headers,
            ...authorization,
            "accept-encoding": "identity",
          }),
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeoutOption("30 seconds"),
      );
    if (Option.isNone(result)) return null;
    const response: HttpClientResponse.HttpClientResponse = result.value;
    if (response.status < 300 || response.status >= 400) return response;
    if (!response.headers.location || hop >= 3) return null;
    const next = URL.parse(response.headers.location, target);
    if (next === null || next.protocol !== "https:" || next.username || next.password) return null;
    target = next.href;
  }
});

export const linearMediaResponse = Effect.fn("LinearMediaFetch.response")(function* (
  asset: { readonly url: string; readonly issue: IssueRef; readonly expiresAt: number },
  requestHeaders: Record<string, string | undefined>,
) {
  const headers: Record<string, string> = {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (
    asset.expiresAt <= (yield* Clock.currentTimeMillis) ||
    linearMediaFetchUrl(asset.url) === null ||
    !(yield* linearMediaSourceAvailable(asset.issue))
  )
    return HttpServerResponse.empty({ status: 404, headers });
  const token = yield* IssueTrackerHost.IssueTrackerHost.pipe(
    Effect.flatMap((host) => host.credentials.get(LINEAR, asset.issue.connectionId)),
    Effect.provideService(IssueTrackerHost.ConnectionId, asset.issue.connectionId),
    Effect.provide(IssueTrackerHostLive.layer),
  );
  if (Option.isNone(token)) return HttpServerResponse.empty({ status: 404, headers });
  const forwarded: Record<string, string> = {};
  for (const name of ["range", "if-range"] as const) {
    const value = requestHeaders[name];
    if (value !== undefined) forwarded[name] = value;
  }
  const response = yield* fetchMedia(asset.url, forwarded, token.value);
  if (response === null) return HttpServerResponse.empty({ status: 502, headers });
  if (response.status >= 400)
    return HttpServerResponse.empty({
      status: response.status >= 500 ? 502 : response.status,
      headers,
    });
  const upstreamType =
    response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const contentType = MEDIA_CONTENT_TYPE_PATTERN.test(upstreamType)
    ? upstreamType
    : Option.getOrElse(Mime.getType(new URL(asset.url).pathname), () => "").toLowerCase();
  if (!MEDIA_CONTENT_TYPE_PATTERN.test(contentType))
    return HttpServerResponse.empty({ status: 415, headers });
  headers["content-type"] = contentType;
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  if (contentType === "image/svg+xml")
    headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    contentType,
  });
});
