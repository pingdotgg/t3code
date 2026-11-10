import type { ReadWriteBucketClient } from "@alchemy.run/cloudflare/R2/ReadWriteBucket";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";

/** Real native R2 bodies cross the public read/write binding in these routes. */
export const streamRoutes = (
  r2: ReadWriteBucketClient,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    const key = url.searchParams.get("key") ?? "";
    if (request.method === "PUT" && url.pathname === "/copy-source") {
      const body = yield* request.text;
      const stored = yield* r2.put(key, body, {
        httpMetadata: { contentType: "application/octet-stream", cacheControl: "max-age=60" },
        customMetadata: { purpose: "stream-copy", label: key },
      });
      return yield* HttpServerResponse.json({ size: stored.size });
    }
    if (request.method === "GET" && url.pathname === "/copy-readback") {
      const object = yield* r2.get(key);
      if (object === null) return yield* HttpServerResponse.json({ exists: false });
      const bytes = yield* object.bytes();
      return yield* HttpServerResponse.json({
        exists: true,
        size: object.size,
        bytes: Array.from(bytes),
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
      });
    }
    if (request.method !== "POST" || url.pathname !== "/copy-stream") return undefined;

    const source = url.searchParams.get("source") ?? "";
    const offset = url.searchParams.get("offset");
    const rangeLength = url.searchParams.get("rangeLength");
    const object = yield* r2.get(
      source,
      offset === null || rangeLength === null
        ? undefined
        : { range: { offset: Number(offset), length: Number(rangeLength) } },
    );
    if (object === null) return HttpServerResponse.text("Source missing", { status: 404 });
    const transformed = url.searchParams.get("transform") === "invert";
    const body = transformed
      ? object.body.pipe(Stream.map((chunk) => chunk.map((byte) => byte ^ 0xff)))
      : object.body;
    const contentLength = url.searchParams.get("contentLength");
    const sha256 = url.searchParams.get("sha256");
    return yield* r2
      .put(key, body, {
        // This public conditional overload accepts a native body without a
        // contentLength hint. Existing destinations must not be overwritten.
        onlyIf: { etagDoesNotMatch: "*" },
        ...(contentLength === null ? {} : { contentLength: Number(contentLength) }),
        ...(sha256 === null ? {} : { sha256 }),
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
      })
      .pipe(
        Effect.flatMap((stored) =>
          HttpServerResponse.json({ stored: stored !== null, size: stored?.size ?? null }),
        ),
      );
  }).pipe(
    Effect.catchTag("R2Error", (error) =>
      HttpServerResponse.json({ stored: false, error: error.message }, { status: 400 }),
    ),
  );
