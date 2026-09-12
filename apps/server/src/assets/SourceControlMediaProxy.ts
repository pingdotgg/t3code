import {
  isSourceControlMediaReference,
  type SourceControlMediaReference,
} from "@t3tools/contracts";
import { mediaMimeType } from "@t3tools/shared/filePreview";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, type HttpClientError } from "effect/unstable/http";

import * as SourceControlMediaCredentials from "../sourceControl/SourceControlMediaCredentials.ts";

export type SourceControlMediaDelivery =
  | { readonly kind: "redirect"; readonly location: string; readonly cacheControl: string }
  | {
      readonly kind: "stream";
      readonly body: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>;
      readonly contentType: string;
      readonly status: 200 | 206;
      readonly headers: Readonly<Record<string, string>>;
    }
  | { readonly kind: "range-not-satisfiable"; readonly contentRange: string | undefined };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A cached redirect must expire before its target; unknown signature formats are not cached. */
export function sourceControlRedirectCacheControl(location: string, now: number): string {
  const params = new URL(location).searchParams;
  const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(
    params.get("X-Amz-Date") ?? "",
  );
  const duration = params.get("X-Amz-Expires");
  if (date === null || duration === null || !/^\d+$/u.test(duration)) return "private, no-store";
  const signedAt = DateTime.make(
    `${date[1]}-${date[2]}-${date[3]}T${date[4]}:${date[5]}:${date[6]}Z`,
  );
  if (Option.isNone(signedAt)) return "private, no-store";
  const maxAge = Math.min(
    240,
    Math.floor((DateTime.toEpochMillis(signedAt.value) - now) / 1000 + Number(duration)) - 60,
  );
  return maxAge > 0 ? `private, max-age=${maxAge}` : "private, no-store";
}

function redirectLocation(value: string | undefined, base: string): URL | null {
  try {
    const url = new URL(value ?? "", base);
    return value !== undefined &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && new URL(base).protocol === "http:"))
      ? url
      : null;
  } catch {
    return null;
  }
}

export class SourceControlMediaProxy extends Context.Service<
  SourceControlMediaProxy,
  {
    readonly resolve: (
      reference: SourceControlMediaReference,
      range?: string,
    ) => Effect.Effect<SourceControlMediaDelivery | null, never, Scope.Scope>;
  }
>()("t3/assets/SourceControlMediaProxy") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const credentials = yield* SourceControlMediaCredentials.SourceControlMediaCredentials;
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const resolve = Effect.fn("SourceControlMediaProxy.resolve")(
    function* (
      reference: SourceControlMediaReference,
      range?: string,
    ): Effect.fn.Return<
      SourceControlMediaDelivery | null,
      HttpClientError.HttpClientError | Cause.TimeoutError,
      Scope.Scope
    > {
      // Check again where credentials enter a request, including non-RPC callers.
      if (!isSourceControlMediaReference(reference)) return null;
      if (reference._tag === "github") {
        const token = yield* credentials.gitHubToken;
        const location = yield* client
          .get(reference.url, {
            headers: token === null ? {} : { authorization: `token ${token}` },
          })
          .pipe(
            Effect.map((response) =>
              REDIRECT_STATUSES.has(response.status)
                ? redirectLocation(response.headers.location, reference.url)
                : null,
            ),
            Effect.timeout("15 seconds"),
            Effect.scoped,
          );
        return location === null
          ? null
          : {
              kind: "redirect",
              location: location.toString(),
              cacheControl: sourceControlRedirectCacheControl(
                location.toString(),
                yield* Clock.currentTimeMillis,
              ),
            };
      }
      const connection = yield* credentials.gitLabConnection(reference.origin);
      if (connection === null) return null;
      // A subfolder belongs to the installation, not the repository's API identifier.
      const subfolder = connection.apiBaseUrl.pathname
        .replace(/\/api\/v4\/$/u, "")
        .replace(/^\//u, "");
      const project =
        subfolder && reference.project.startsWith(`${subfolder}/`)
          ? reference.project.slice(subfolder.length + 1)
          : reference.project;
      let url = new URL(
        `projects/${encodeURIComponent(project)}/uploads/${reference.secret}/${encodeURIComponent(reference.fileName)}`,
        connection.apiBaseUrl,
      );
      let authenticated = true;
      for (let hop = 0; hop < 5; hop++) {
        const response = yield* client
          .get(url.toString(), {
            headers: {
              ...(authenticated ? { "private-token": connection.token } : {}),
              "accept-encoding": "identity",
              ...(range && /^bytes=(?:\d+-\d*|-\d+)$/u.test(range) ? { range } : {}),
            },
          })
          .pipe(Effect.timeout("15 seconds"));
        if (REDIRECT_STATUSES.has(response.status)) {
          const next = redirectLocation(response.headers.location, url.toString());
          if (next === null) return null;
          // Object storage redirects must never receive the GitLab token, even if a later hop returns.
          authenticated = authenticated && next.origin === url.origin;
          url = next;
          continue;
        }
        const upstreamContentType = response.headers["content-type"]
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        const encoded =
          response.headers["content-encoding"] !== undefined &&
          response.headers["content-encoding"] !== "identity";
        const contentRange = response.headers["content-range"];
        if (response.status === 416) {
          return {
            kind: "range-not-satisfiable",
            contentRange:
              contentRange && /^bytes \*\/\d+$/u.test(contentRange) ? contentRange : undefined,
          };
        }
        // GitLab serves uploaded files as octet-stream, including PNGs and MP4s.
        const contentType =
          upstreamContentType === "application/octet-stream"
            ? mediaMimeType(reference.fileName)
            : upstreamContentType;
        if (
          (response.status !== 200 && response.status !== 206) ||
          !(contentType?.startsWith("image/") || contentType?.startsWith("video/"))
        )
          return null;
        if (
          response.status === 206 &&
          (encoded || !contentRange || !/^bytes \d+-\d+\/\d+$/u.test(contentRange))
        )
          return null;
        const contentLength = response.headers["content-length"];
        return {
          kind: "stream",
          body: response.stream,
          contentType,
          status: response.status,
          headers: {
            ...(response.headers["accept-ranges"] === "bytes" ? { "accept-ranges": "bytes" } : {}),
            ...(response.status === 206 && contentRange ? { "content-range": contentRange } : {}),
            ...(!encoded && contentLength && /^\d+$/u.test(contentLength)
              ? { "content-length": contentLength }
              : {}),
          },
        };
      }
      return null;
    },
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    // Failures can contain signed URLs or request headers. Expose only the unavailable result.
    Effect.orElseSucceed(() => null),
  );
  return SourceControlMediaProxy.of({ resolve });
});

export const layer = Layer.effect(SourceControlMediaProxy, make);
