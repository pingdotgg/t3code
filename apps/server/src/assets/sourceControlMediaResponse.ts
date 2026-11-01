import * as Mime from "effect/http/Mime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerResponse } from "effect/http";

import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

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

export const sourceControlMediaResponse = Effect.fn(
  "SourceControlMediaResponse.sourceControlMediaResponse",
)(function* (
  asset: { readonly url: string; readonly cwd: string; readonly expiresAt: number },
  requestHeaders: Record<string, string | undefined>,
) {
  const remainingSeconds = Math.floor((asset.expiresAt - (yield* Clock.currentTimeMillis)) / 1000);
  const headers: Record<string, string> = {
    "cache-control":
      remainingSeconds > 0 ? `private, max-age=${remainingSeconds}` : "private, no-store",
    "x-content-type-options": "nosniff",
  };
  const media = sourceControlDefinitions.mediaUrl(asset.url);
  const drivers = yield* BuiltInDrivers.SourceControlDrivers;
  const fetchMedia = drivers.find(({ driver }) => driver.kind === media?.definition.kind)?.instance
    .fetchMedia;
  if (media === null || fetchMedia === undefined) {
    return HttpServerResponse.empty({ status: 404, headers });
  }
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = requestHeaders[name];
    if (value !== undefined) forwarded[name] = value;
  }
  const response = yield* fetchMedia({ url: asset.url, headers: forwarded });
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
    : Option.getOrElse(Mime.getType(media.fileName), () => "").toLowerCase();
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
